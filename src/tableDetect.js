/**
 * tableDetect.js
 * Finds ruled tables on a PDF page and turns their cells into text.
 *
 * A table is recognised from the page's own drawing operators: horizontal and
 * vertical rules that intersect form a grid. Cell rectangles (drawn as filled
 * boxes) contribute their four edges as well, so a table with only boxed cells
 * is found too. Text is assigned to the cell that contains it, which keeps the
 * row/column structure that plain line grouping loses when neighbouring cells
 * touch.
 *
 * Everything here is pure: pdf.js operator arrays go in, plain table objects
 * come out.
 */

const RULE_TOLERANCE = 2.5;
const MIN_RULE_LENGTH = 8;

function transformPoint(ctm, x, y) {
  return [
    ctm[0] * x + ctm[2] * y + ctm[4],
    ctm[1] * x + ctm[3] * y + ctm[5],
  ];
}

function multiply(m, t) {
  return [
    m[0] * t[0] + m[2] * t[1],
    m[1] * t[0] + m[3] * t[1],
    m[0] * t[2] + m[2] * t[3],
    m[1] * t[2] + m[3] * t[3],
    m[0] * t[4] + m[2] * t[5] + m[4],
    m[1] * t[4] + m[3] * t[5] + m[5],
  ];
}

/**
 * Walk a page's operator list and collect horizontal/vertical rules plus
 * cell-sized rectangles. Coordinates are PDF user space with y growing up,
 * offset by the CropBox origin.
 *
 * @param {object[]} fnArray
 * @param {object[]} argsArray
 * @param {object} OPS pdf.js operator constants
 * @param {{x0?: number, y0?: number, pageWidth: number, pageHeight: number}} page
 */
export function extractRules(fnArray, argsArray, OPS, page) {
  const { x0 = 0, y0 = 0, pageWidth = 612, pageHeight = 792 } = page || {};
  const rules = [];
  const rects = [];

  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];

  const pushSegment = (a, b) => {
    const dx = Math.abs(a[0] - b[0]);
    const dy = Math.abs(a[1] - b[1]);
    if (dx <= 1.5 && dy >= MIN_RULE_LENGTH) {
      const x = (a[0] + b[0]) / 2 - x0;
      const y1 = Math.min(a[1], b[1]) - y0;
      const y2 = Math.max(a[1], b[1]) - y0;
      if (y2 - y1 <= pageHeight * 0.97) rules.push({ kind: 'v', x, y1, y2 });
      return;
    }
    if (dy <= 1.5 && dx >= MIN_RULE_LENGTH) {
      const y = (a[1] + b[1]) / 2 - y0;
      const x1 = Math.min(a[0], b[0]) - x0;
      const x2 = Math.max(a[0], b[0]) - x0;
      if (x2 - x1 <= pageWidth * 0.97) rules.push({ kind: 'h', y, x1, x2 });
    }
  };

  for (let i = 0; i < fnArray.length; i += 1) {
    const fn = fnArray[i];
    const args = argsArray[i];

    if (fn === OPS.save) {
      stack.push(ctm.slice());
      continue;
    }
    if (fn === OPS.restore) {
      ctm = stack.pop() || ctm;
      continue;
    }
    if (fn === OPS.transform) {
      ctm = multiply(ctm, args);
      continue;
    }
    if (fn !== OPS.constructPath) continue;

    const opList = Array.isArray(args?.[0]) ? args[0] : [];
    const data = Array.isArray(args?.[1]) ? args[1] : [];
    let k = 0;
    let subpath = [];

    const flushPath = () => {
      for (let p = 1; p < subpath.length; p += 1) {
        pushSegment(subpath[p - 1], subpath[p]);
      }
      subpath = [];
    };

    for (const op of opList) {
      if (op === OPS.rectangle) {
        flushPath();
        const x = data[k];
        const y = data[k + 1];
        const width = data[k + 2];
        const height = data[k + 3];
        k += 4;
        if (![x, y, width, height].every(Number.isFinite)) continue;
        const corners = [
          transformPoint(ctm, x, y),
          transformPoint(ctm, x + width, y),
          transformPoint(ctm, x + width, y + height),
          transformPoint(ctm, x, y + height),
        ];
        const xs = corners.map((point) => point[0]);
        const ys = corners.map((point) => point[1]);
        const left = Math.min(...xs) - x0;
        const right = Math.max(...xs) - x0;
        const bottom = Math.min(...ys) - y0;
        const top = Math.max(...ys) - y0;
        rects.push({ x: left, y: bottom, width: right - left, height: top - bottom });
        continue;
      }
      if (op === OPS.moveTo) {
        flushPath();
        subpath.push(transformPoint(ctm, data[k], data[k + 1]));
        k += 2;
        continue;
      }
      if (op === OPS.lineTo) {
        subpath.push(transformPoint(ctm, data[k], data[k + 1]));
        k += 2;
        continue;
      }
      if (op === OPS.closePath) {
        flushPath();
        continue;
      }
      if (op === OPS.curveTo) {
        k += 6;
        continue;
      }
      if (op === OPS.curveTo2 || op === OPS.curveTo3) {
        k += 4;
      }
    }
    flushPath();
  }

  return { rules, rects };
}

/** Merge collinear rules into one span, so dashed borders become a line. */
function clusterRules(rules, kind) {
  const key = kind === 'h' ? 'y' : 'x';
  const start = kind === 'h' ? 'x1' : 'y1';
  const end = kind === 'h' ? 'x2' : 'y2';
  const sorted = rules
    .filter((rule) => rule.kind === kind)
    .sort((a, b) => a[key] - b[key] || a[start] - b[start]);
  const clusters = [];

  for (const rule of sorted) {
    const last = clusters[clusters.length - 1];
    const near = last && Math.abs(last[key] - rule[key]) <= RULE_TOLERANCE;
    const touching = last && rule[start] <= last[end] + 6 && rule[end] >= last[start] - 6;
    if (near && touching) {
      last[key] = (last[key] * last.count + rule[key]) / (last.count + 1);
      last.count += 1;
      last[start] = Math.min(last[start], rule[start]);
      last[end] = Math.max(last[end], rule[end]);
    } else {
      clusters.push({
        kind,
        [key]: rule[key],
        [start]: rule[start],
        [end]: rule[end],
        count: 1,
      });
    }
  }
  return clusters;
}

/** Turn a page's rules into grid components (one component per table). */
function gridComponents(horizontals, verticals) {
  const parent = new Map();
  const find = (item) => {
    let root = item;
    while (parent.get(root) !== root) root = parent.get(root);
    let node = item;
    while (parent.get(node) !== root) {
      const next = parent.get(node);
      parent.set(node, root);
      node = next;
    }
    return root;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  horizontals.forEach((rule) => parent.set(rule, rule));
  verticals.forEach((rule) => parent.set(rule, rule));

  for (const h of horizontals) {
    for (const v of verticals) {
      if (
        v.x >= h.x1 - 1 &&
        v.x <= h.x2 + 1 &&
        h.y >= v.y1 - 1 &&
        h.y <= v.y2 + 1
      ) {
        union(h, v);
      }
    }
  }

  const groups = new Map();
  for (const rule of [...horizontals, ...verticals]) {
    const root = find(rule);
    if (!groups.has(root)) groups.set(root, { horizontals: [], verticals: [] });
    const group = groups.get(root);
    if (rule.kind === 'h') group.horizontals.push(rule);
    else group.verticals.push(rule);
  }

  return [...groups.values()].filter(
    (group) => group.horizontals.length >= 2 && group.verticals.length >= 2,
  );
}

function uniquePositions(values, tolerance = RULE_TOLERANCE) {
  const sorted = [...values].sort((a, b) => a - b);
  const result = [];
  for (const value of sorted) {
    if (!result.length || Math.abs(result[result.length - 1] - value) > tolerance) {
      result.push(value);
    }
  }
  return result;
}

function itemCell(items, xs, ys, item) {
  const centerX = item.x + item.width / 2;
  const centerY = item.y + item.height * 0.35;
  let column = -1;
  for (let i = 0; i + 1 < xs.length; i += 1) {
    if (centerX >= xs[i] - 1 && centerX <= xs[i + 1] + 1) {
      column = i;
      break;
    }
  }
  let row = -1;
  for (let i = 0; i + 1 < ys.length; i += 1) {
    if (centerY <= ys[i] + 1 && centerY >= ys[i + 1] - 1) {
      row = i;
      break;
    }
  }
  return row >= 0 && column >= 0 ? { row, column } : null;
}

/**
 * Group a cell's text items into visual lines. Items on the same baseline are
 * one line; a wrapped paragraph produces several lines here.
 */
function cellLines(entries) {
  const sorted = [...entries].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];

  for (const entry of sorted) {
    const line = lines[lines.length - 1];
    const tolerance = Math.max(
      1.5,
      Math.max(line?.fontSize || 10, entry.fontSize || 10) * 0.3,
    );
    if (line && Math.abs(line.y - entry.y) <= tolerance) {
      line.entries.push(entry);
      line.fontSize = Math.max(line.fontSize, entry.fontSize || 10);
    } else {
      lines.push({ y: entry.y, fontSize: entry.fontSize || 10, entries: [entry] });
    }
  }

  return lines;
}

function appendRun(runs, text, bold) {
  if (!text) return;
  const last = runs[runs.length - 1];
  if (last && last.bold === bold) last.text += text;
  else runs.push({ text, bold });
}

/**
 * Join one cell line into styled runs. A wide gap between runs is a word
 * break; adjacent pieces from a split glyph (`speci` + `fi` + `c`) are not.
 * Bold is kept per run so ink like `Metrics:` survives in the table view.
 */
function lineRuns(entries) {
  const sorted = [...entries].sort((a, b) => a.x - b.x);
  const runs = [];
  let previous = null;

  for (const entry of sorted) {
    const trimmed = String(entry.text || '').trim();
    if (!trimmed) continue;
    const spaced =
      previous &&
      entry.x - (previous.x + previous.width) > Math.max(0.8, entry.fontSize * 0.2);
    appendRun(runs, spaced ? ` ${trimmed}` : trimmed, Boolean(entry.bold));
    previous = entry;
  }

  if (!runs.length) return { text: '', runs };
  runs[0].text = runs[0].text.replace(/^ +/, '');
  const last = runs[runs.length - 1];
  last.text = last.text.replace(/ +$/, '');
  return { text: runs.map((run) => run.text).join(''), runs };
}

/** Median of the positive baseline gaps between a cell's lines. */
function medianGap(lines) {
  const gaps = [];
  for (let i = 1; i < lines.length; i += 1) {
    const gap = lines[i - 1].y - lines[i].y;
    if (gap > 0) gaps.push(gap);
  }
  if (!gaps.length) return 0;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

/**
 * Split a cell's lines into paragraphs. A cell in a PDF rarely has blank
 * lines in its text layer, but it does keep the extra baseline gap that the
 * blank line produced, so a gap well above normal leading starts a paragraph.
 */
function cellParagraphs(lines) {
  if (lines.length <= 1) return [lines];

  const size = Math.max(...lines.map((line) => line.fontSize || 10), 10);
  const normal = Math.max(size * 1.05, Math.min(medianGap(lines) || Infinity, size * 1.35));
  const threshold = normal * 1.5;

  const groups = [];
  let current = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (i > 0 && lines[i - 1].y - lines[i].y > threshold && current.length) {
      groups.push(current);
      current = [];
    }
    current.push(lines[i]);
  }
  if (current.length) groups.push(current);
  return groups;
}

/** Flatten paragraph lines into runs, keeping a space at each line break. */
function paragraphFromLines(lines) {
  const runs = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (i > 0 && runs.length) runs[runs.length - 1].text += ' ';
    for (const run of lines[i].runs) appendRun(runs, run.text, run.bold);
  }
  if (!runs.length) return { text: '', runs };

  for (const run of runs) run.text = run.text.replace(/ {2,}/g, ' ');
  runs[0].text = runs[0].text.replace(/^ +/, '');
  const last = runs[runs.length - 1];
  last.text = last.text.replace(/ +$/, '');
  return { text: runs.map((run) => run.text).join(''), runs };
}

/**
 * Turn one cell's items into text plus, when the cell needs it, paragraphs of
 * styled runs. `text` stays a single line for search and for simple cells;
 * `paragraphs` is added only when the cell has several paragraphs or mixed
 * weight, so callers can render `Metrics:`/`Best For:` as separate blocks.
 */
function joinCellItems(entries) {
  if (!entries.length) return { text: '', bold: false };

  const lines = cellLines(entries).map((line) => ({
    ...line,
    ...lineRuns(line.entries),
  }));
  const paragraphs = cellParagraphs(lines).map((group) =>
    paragraphFromLines(group),
  );
  const text = paragraphs
    .map((paragraph) => paragraph.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  let chars = 0;
  let boldChars = 0;
  for (const run of paragraphs.flatMap((paragraph) => paragraph.runs)) {
    chars += run.text.length;
    if (run.bold) boldChars += run.text.length;
  }

  const cell = {
    text,
    bold: chars > 0 && boldChars / chars >= 0.6,
  };

  const mixedWeight = paragraphs.some(
    (paragraph) =>
      paragraph.runs.some((run) => run.bold) &&
      paragraph.runs.some((run) => !run.bold),
  );
  if (paragraphs.length > 1 || mixedWeight) {
    cell.paragraphs = paragraphs;
  }
  return cell;
}

/** Detect grids from one set of rules (explicit lines or rectangle edges). */
function detectFromSegments(segments, items, pageWidth, pageHeight) {
  const horizontals = clusterRules(segments, 'h');
  const verticals = clusterRules(segments, 'v');
  if (horizontals.length < 2 || verticals.length < 2) return [];

  const tables = [];
  for (const group of gridComponents(horizontals, verticals)) {
    const xs = uniquePositions(group.verticals.map((rule) => rule.x));
    const ys = uniquePositions(group.horizontals.map((rule) => rule.y)).sort(
      (a, b) => b - a,
    );
    if (xs.length < 3 || ys.length < 3) continue;

    const left = xs[0];
    const right = xs[xs.length - 1];
    const top = ys[0];
    const bottom = ys[ys.length - 1];
    if (right - left < 60 || top - bottom < 30) continue;

    const grid = ys.slice(0, -1).map(() => xs.slice(0, -1).map(() => []));
    for (const item of items) {
      if (!item?.str || !item.str.trim()) continue;
      const x = item.x ?? item.transform?.[4];
      const y = item.y ?? item.transform?.[5];
      const width = item.width ?? 0;
      const height = item.height ?? Math.abs(item.transform?.[3] || 0);
      if (![x, y, width, height].every(Number.isFinite)) continue;
      const cell = itemCell(items, xs, ys, { x, y, width, height });
      if (!cell) continue;
      grid[cell.row][cell.column].push({
        text: item.str,
        x,
        y,
        width,
        height,
        fontSize: height || 10,
        bold: Boolean(item.bold),
      });
    }

    const rows = grid
      .map((row) => row.map((entries) => joinCellItems(entries)))
      .filter((row) => row.some((cell) => cell.text));
    if (!rows.length) continue;

    // Reject boxes that merely contain a rule: a bordered callout, a code
    // listing, a two-column quote. A real table fills most of its grid, has
    // several cells per row, and uses every column.
    const columnCount = xs.length - 1;
    const cells = rows.flat();
    const filled = cells.filter((cell) => cell.text).length;
    const filledRatio = filled / cells.length;
    const multiCellRows =
      rows.filter((row) => row.filter((cell) => cell.text).length >= 2).length /
      rows.length;
    const columnOccupancy = Array.from({ length: columnCount }, (_, column) =>
      rows.filter((row) => row[column]?.text).length / rows.length,
    );
    if (
      filledRatio < 0.55 ||
      multiCellRows < 0.6 ||
      columnOccupancy.some((ratio) => ratio < 0.35)
    ) {
      continue;
    }

    const firstRow = rows[0];
    const header =
      firstRow.length > 0 &&
      firstRow.every((cell) => cell.text) &&
      firstRow.every((cell) => cell.bold);

    tables.push({
      x: left,
      y: bottom,
      width: right - left,
      height: top - bottom,
      columns: xs.length - 1,
      rows: rows.map((row) =>
        row.map((cell) => {
          const value = { text: cell.text, bold: cell.bold };
          if (cell.paragraphs) value.paragraphs = cell.paragraphs;
          return value;
        }),
      ),
      header,
    });
  }

  return tables;
}

/**
 * Detect ruled tables.
 *
 * Explicit rules are trusted first: cell rectangles often have different
 * heights because their text wraps, and using their edges alongside a drawn
 * grid would add empty half-rows. Rectangles are used only for boxes that the
 * explicit grid did not already cover.
 *
 * @param {object} input
 * @param {object[]} input.items pdf.js text items (x/y/width/height/str)
 * @param {object[]} input.rules rules from `extractRules`
 * @param {object[]} input.rects rectangles from `extractRules`
 * @param {number} input.pageWidth
 * @param {number} input.pageHeight
 * @returns {object[]} tables with `x`, `y`, `width`, `height`, `rows`, `header`
 */
export function detectTables({ items = [], rules = [], rects = [], pageWidth = 612, pageHeight = 792 } = {}) {
  const pageArea = pageWidth * pageHeight;
  const tables = detectFromSegments(rules, items, pageWidth, pageHeight);

  const covered = (rect) => {
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    return tables.some(
      (table) =>
        cx >= table.x - 2 &&
        cx <= table.x + table.width + 2 &&
        cy >= table.y - 2 &&
        cy <= table.y + table.height + 2,
    );
  };

  const rectRules = [];
  for (const rect of rects) {
    const { x, y, width, height } = rect;
    if (!(width >= 20 && height >= 12)) continue;
    if (width > pageWidth * 0.9 || height > pageHeight * 0.5) continue;
    if (width * height > pageArea * 0.3) continue;
    if (covered(rect)) continue;
    rectRules.push(
      { kind: 'h', y, x1: x, x2: x + width },
      { kind: 'h', y: y + height, x1: x, x2: x + width },
      { kind: 'v', x, y1: y, y2: y + height },
      { kind: 'v', x: x + width, y1: y, y2: y + height },
    );
  }

  if (rectRules.length) {
    tables.push(...detectFromSegments(rectRules, items, pageWidth, pageHeight));
  }

  return tables.sort((a, b) => b.y + b.height - (a.y + a.height) || a.x - b.x);
}
