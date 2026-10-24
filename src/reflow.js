/**
 * reflow.js
 *
 * Pure layout/reading-order logic for turning pdf.js text items into
 * EPUB-like paragraphs. This module deliberately imports nothing: it can be
 * unit tested in Node with plain coordinate data.
 *
 * Coordinate convention: PDF user space, y grows upwards. A line's `y` is its
 * baseline, `x` its left edge, `width` its rendered width in PDF points.
 */

export const REFLOW_VERSION = 7;

export const DEFAULT_REFLOW_OPTIONS = Object.freeze({
  /** Baseline distance, as a fraction of font size, for items to share a line. */
  lineTolerance: 0.55,
  /** Baseline gap (as a multiple of 1.2em leading) that starts a new paragraph. */
  paragraphGap: 1.55,
  /** First-line indent (em) that starts a new paragraph. */
  indentEm: 0.9,
  /** A line shorter than this fraction of its column is treated as a paragraph end. */
  shortLineRatio: 0.7,
  /** Font scale for h2 / h3. */
  headingH2: 1.55,
  headingH3: 1.18,
  /** Text below this fraction of body size is styled as small print. */
  smallText: 0.84,
  /** Column gutter detection. */
  gutterRatio: 0.03,
  fullWidthRatio: 0.72,
  /** Margin zone (fraction of page height) for running heads/page numbers. */
  marginalZone: 0.12,
  marginalRepeatRatio: 0.4,
  marginalMaxChars: 120,
  /** Join words hyphenated across a line break when the next line is lowercase. */
  joinHyphenation: true,
  /** Drop repeated running heads, footers and page numbers. */
  removeHeaderFooter: true,
});

const SENTENCE_END = /[.!?\u2026]["'\u201d\u2019)\]]?$/u;
const HYPHEN_END = /[\p{L}\p{N}]-(?:\u00AD)?$/u;
const LOWERCASE_START = /^\p{Ll}/u;
const CLOSING_PUNCT_START = /^[,.;:!?\u2026)\]}%]/u;

const ARABIC_PAGE_NUMBER =
  /^(?:page\s*)?[-\u2013\u2014\s]*\d{1,4}(?:\s*(?:of|\/|[-\u2013\u2014])\s*\d{1,4})?[-\u2013\u2014\s]*$/i;
const ROMAN_PAGE_NUMBER = /^[ivxlcdm]{1,7}$/i;

/**
 * Bullets that open a list item: filled/hollow circles, squares, diamonds,
 * triangles, checks, dashes. The study guide nests a filled square (`■`,
 * U+25A0) under hollow circles, so leaving it out merges the whole sub-list
 * into the parent item.
 */
const BULLET_MARKER =
  /^([\u25A0\u25A1\u25AA\u25AB\u25B6\u25B7\u25BA\u25BB\u25C6\u25C7\u25CF\u25CB\u25C9\u25E6\u25B8\u25B9\u2022\u2023\u2043\u00B7*\u2013\u2014\u2713\u2714-])\s+/u;
/**
 * Ordered markers: `1.`, `1)`, `(1)`, `a.`, `a)`, `iv.`. Uppercase letters are
 * excluded because `A. Smith` is a name, not a list item.
 */
const ORDERED_MARKER =
  /^(?:\((\d{1,3}|[a-z]|[ivxlcdm]{1,5})\)|(\d{1,3}|[a-z]|[ivxlcdm]{1,5})[.)])\s+/u;

/**
 * Split a leading list marker from a line. Returns null when the line is not a
 * list item.
 *
 * @param {string} text
 * @returns {{ordered: boolean, marker: string, number: number|null, text: string}|null}
 */
export function detectListMarker(text) {
  const value = String(text ?? '').trimStart();
  if (!value) return null;

  const bullet = value.match(BULLET_MARKER);
  if (bullet) {
    const body = value.slice(bullet[0].length).trim();
    if (!body) return null;
    return { ordered: false, marker: bullet[1], number: null, text: body };
  }

  const ordered = value.match(ORDERED_MARKER);
  if (ordered) {
    const body = value.slice(ordered[0].length).trim();
    if (!body) return null;
    const marker = ordered[1] || ordered[2];
    return {
      ordered: true,
      marker,
      number: /^\d+$/.test(marker) ? Number(marker) : null,
      text: body,
    };
  }

  return null;
}

/**
 * Nesting level for the next list item, derived from its left edge relative to
 * the previous item. Continuation lines never reach this function.
 */
function nextListLevel(items, line) {
  const last = items[items.length - 1];
  if (!last) return 0;
  const em = line.fontSize || 10;
  if (line.x > last.x + em * 0.8) return Math.min(3, last.level + 1);
  if (line.x < last.x - em * 0.8) {
    for (let i = items.length - 1; i >= 0; i -= 1) {
      if (Math.abs(items[i].x - line.x) <= em * 0.8) return items[i].level;
    }
    return 0;
  }
  return last.level;
}

/* ------------------------------------------------------------------ */
/* small helpers                                                      */
/* ------------------------------------------------------------------ */

export function median(values) {
  const nums = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!nums.length) return 0;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

export function quantile(values, q) {
  const nums = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!nums.length) return 0;
  const pos = Math.min(1, Math.max(0, q)) * (nums.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return nums[lo] + (nums[hi] - nums[lo]) * (pos - lo);
}

function weightedMedian(entries) {
  const rows = entries
    .filter((entry) => Number.isFinite(entry.value) && entry.weight > 0)
    .sort((a, b) => a.value - b.value);
  if (!rows.length) return 0;
  const total = rows.reduce((sum, row) => sum + row.weight, 0);
  let running = 0;
  for (const row of rows) {
    running += row.weight;
    if (running >= total / 2) return row.value;
  }
  return rows[rows.length - 1].value;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function toSignatureSet(value) {
  if (!value) return new Set();
  if (value instanceof Set) return value;
  if (Array.isArray(value)) return new Set(value);
  if (typeof value === 'object') return new Set(Object.keys(value));
  return new Set();
}

/* ------------------------------------------------------------------ */
/* text items -> lines                                                */
/* ------------------------------------------------------------------ */

/**
 * Accepts a raw pdf.js text item or an already-normalized item.
 * pdf.js items look like: { str, transform: [a,b,c,d,e,f], width, height,
 * fontName, hasEOL }.
 */
export function normalizeTextItem(item, index = 0) {
  const raw = item || {};
  const hasTransform = Array.isArray(raw.transform) && raw.transform.length === 6;
  const tr = hasTransform ? raw.transform : [1, 0, 0, 1, 0, 0];
  const fontSize = Number.isFinite(raw.fontSize)
    ? raw.fontSize
    : Math.hypot(tr[2], tr[3]) || Math.abs(raw.height) || 10;
  const str = String(raw.str ?? '').replace(/\u00a0/g, ' ');
  const width =
    Number.isFinite(raw.width) && raw.width > 0
      ? raw.width
      : Math.max(0, str.trim().length * fontSize * 0.5);
  return {
    str,
    x: Number.isFinite(raw.x) ? raw.x : tr[4] || 0,
    y: Number.isFinite(raw.y) ? raw.y : tr[5] || 0,
    width,
    height: Math.abs(raw.height) || fontSize,
    fontSize,
    angle: Number.isFinite(raw.angle)
      ? raw.angle
      : hasTransform
        ? (Math.atan2(tr[1], tr[0]) * 180) / Math.PI
        : 0,
    fontName: raw.fontName || '',
    bold: Boolean(raw.bold),
    hasEOL: Boolean(raw.hasEOL),
    index,
  };
}

function lineTextFromItems(items) {
  const sorted = [...items].sort((a, b) => a.x - b.x || a.index - b.index);
  let text = '';
  let previous = null;

  for (const item of sorted) {
    const raw = item.str.replace(/\u00a0/g, ' ');
    const leadingSpace = /^\s/.test(raw);
    const cleaned = raw.replace(/\s+/g, ' ').trim();
    if (!cleaned) continue;

    if (text) {
      const gap = previous ? item.x - (previous.x + previous.width) : 0;
      const threshold = Math.max(0.8, Math.max(previous?.fontSize || 10, item.fontSize) * 0.17);
      const needsSpace =
        !text.endsWith(' ') &&
        (leadingSpace || gap > threshold) &&
        !CLOSING_PUNCT_START.test(cleaned);
      if (needsSpace) text += ' ';
    }
    text += cleaned;
    previous = item;
  }

  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Group text items into visual lines by baseline proximity.
 * Returns line objects suitable for the rest of the pipeline.
 */
export function groupLines(items, options = {}) {
  const opts = { ...DEFAULT_REFLOW_OPTIONS, ...options };
  if (!Array.isArray(items)) return [];

  const prepared = items
    .map((item, index) => normalizeTextItem(item, index))
    .filter((item) => item.str.trim().length > 0)
    // Ignore watermarks and other strongly rotated runs; they cannot be read
    // as part of a horizontal text flow.
    .filter((item) => Math.abs(item.angle) < 12);

  if (!prepared.length) return [];

  // Top of page first, then left to right. Because we scan in this order, a
  // new item only needs to be compared with the most recent open lines.
  const sorted = [...prepared].sort((a, b) => b.y - a.y || a.x - b.x);
  const open = [];

  for (const item of sorted) {
    let best = null;
    let bestDistance = Infinity;
    const start = Math.max(0, open.length - 5);

    for (let i = start; i < open.length; i += 1) {
      const line = open[i];
      const tolerance = Math.max(
        1.2,
        Math.max(item.fontSize, line.fontSize) * opts.lineTolerance,
      );
      const distance = Math.abs(item.y - line.baseline);
      if (distance > tolerance || distance >= bestDistance) continue;

      // Two items on the same baseline can belong to different columns. Do
      // not merge them across a wide horizontal gap; keep them as separate
      // visual lines so column detection can see the gutter.
      const joinGap = Math.max(8, Math.max(item.fontSize, line.fontSize) * 2.2);
      if (item.x - line.right > joinGap) continue;
      if (line.left - (item.x + item.width) > joinGap) continue;

      best = line;
      bestDistance = distance;
    }

    if (best) {
      best.items.push(item);
      best.left = Math.min(best.left, item.x);
      best.right = Math.max(best.right, item.x + item.width);
    } else {
      open.push({
        items: [item],
        baseline: item.y,
        fontSize: item.fontSize,
        left: item.x,
        right: item.x + item.width,
      });
    }
  }

  const lines = [];
  for (const group of open) {
    const groupItems = group.items;
    const text = lineTextFromItems(groupItems);
    if (!text) continue;

    const fontSize = weightedMedian(
      groupItems.map((item) => ({
        value: item.fontSize,
        weight: Math.max(1, item.str.trim().length),
      })),
    );
    const baseline =
      weightedMedian(
        groupItems.map((item) => ({
          value: item.y,
          weight: Math.max(1, item.str.trim().length),
        })),
      ) || group.baseline;
    const left = Math.min(...groupItems.map((item) => item.x));
    const right = Math.max(...groupItems.map((item) => item.x + item.width));
    const fontName = groupItems.find((item) => item.fontName)?.fontName || '';
    const charCount = groupItems.reduce(
      (sum, item) => sum + item.str.trim().length,
      0,
    );
    const boldChars = groupItems.reduce(
      (sum, item) => sum + (item.bold ? item.str.trim().length : 0),
      0,
    );

    lines.push({
      text,
      x: left,
      y: baseline,
      width: Math.max(0, right - left),
      fontSize,
      maxFontSize: Math.max(...groupItems.map((item) => item.fontSize)),
      fontName,
      bold: charCount > 0 && boldChars / charCount >= 0.6,
      chars: text.length,
    });
  }

  // Reading order for a single column; column detection reorders later.
  return lines.sort((a, b) => b.y - a.y || a.x - b.x);
}

/* ------------------------------------------------------------------ */
/* running heads / footers                                            */
/* ------------------------------------------------------------------ */

export function lineSignature(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isInMargin(line, pageHeight, zone = DEFAULT_REFLOW_OPTIONS.marginalZone) {
  if (!Number.isFinite(pageHeight) || pageHeight <= 0) return false;
  return line.y >= pageHeight * (1 - zone) || line.y <= pageHeight * zone;
}

export function isPageNumberLine(text, { marginal = false } = {}) {
  const value = String(text || '').trim();
  if (!value) return false;
  if (ARABIC_PAGE_NUMBER.test(value)) return true;
  if (marginal && ROMAN_PAGE_NUMBER.test(value) && value.length <= 7) return true;
  return false;
}

export function createMarginalIndex() {
  return { pages: 0, pagesWithMarginals: 0, counts: new Map() };
}

/** Record short lines found in the top/bottom margin of one page. */
export function addPageMarginals(index, lines, pageHeight, options = {}) {
  const opts = { ...DEFAULT_REFLOW_OPTIONS, ...options };
  const seen = new Set();

  for (const line of lines || []) {
    if (!isInMargin(line, pageHeight, opts.marginalZone)) continue;
    if (line.text.length > opts.marginalMaxChars) continue;
    seen.add(lineSignature(line.text));
  }

  index.pages += 1;
  if (seen.size) index.pagesWithMarginals += 1;
  for (const signature of seen) {
    index.counts.set(signature, (index.counts.get(signature) || 0) + 1);
  }
  return index;
}

/**
 * Signatures that recur on enough sampled pages to count as a running head.
 * Two occurrences is the minimum; on a large sample the ratio takes over.
 */
export function findRepeatedMarginals(index, options = {}) {
  const opts = { ...DEFAULT_REFLOW_OPTIONS, ...options };
  if (!index || index.pages === 0) return new Set();
  const needed = Math.max(2, Math.ceil(index.pages * opts.marginalRepeatRatio));
  const repeated = new Set();
  for (const [signature, count] of index.counts) {
    if (count >= needed && signature) repeated.add(signature);
  }
  return repeated;
}

/**
 * Drop page numbers and repeated marginal lines. The page-number rule is
 * independent of repetition, as requested, but is restricted to short lines.
 */
/**
 * A page number in a table of contents sits on the same baseline as its title
 * and to the right of it. Those numbers are content, not furniture, so the
 * marginal filter must leave them in place for the TOC pass to pair up.
 */
function isTocPageNumber(line, lines) {
  if (!isPageNumberLine(line.text)) return false;
  const y = line.y;
  const x = line.x;
  return (lines || []).some(
    (other) =>
      other !== line &&
      other.text &&
      other.text.trim() &&
      !isPageNumberLine(other.text) &&
      Math.abs(other.y - y) <= Math.max(1.5, (line.fontSize || 10) * 0.25) &&
      other.x + other.width <= x + 2,
  );
}

export function stripMarginalLines(lines, pageHeight, repeatedSignatures, options = {}) {
  const opts = { ...DEFAULT_REFLOW_OPTIONS, ...options };
  if (!opts.removeHeaderFooter) return [...(lines || [])];
  const repeated = toSignatureSet(repeatedSignatures);
  const source = lines || [];

  return source.filter((line) => {
    const marginal = isInMargin(line, pageHeight, opts.marginalZone);
    if (isPageNumberLine(line.text, { marginal })) {
      // Running page numbers live in the margin. A contents entry sits in the
      // text block, next to its title, so only that case is kept.
      return !marginal && isTocPageNumber(line, source);
    }
    if (
      marginal &&
      repeated.has(lineSignature(line.text)) &&
      !(opts.bodySize && line.fontSize > opts.bodySize * 1.2)
    ) {
      return false;
    }
    return true;
  });
}

/* ------------------------------------------------------------------ */
/* body size and headings                                             */
/* ------------------------------------------------------------------ */

export function bodyFontSize(lines, options = {}) {
  const opts = { ...DEFAULT_REFLOW_OPTIONS, ...options };
  const rows = (lines || []).filter(
    (line) => line.text && line.text.length > 1 && !isPageNumberLine(line.text),
  );
  // Headings are rare but large; weighting by character count lets a long
  // body dominate. Ignore lines in the outermost 8% if possible so running
  // heads do not affect the baseline.
  const bodyRows = rows.filter(
    (line) =>
      !isInMargin(line, options.pageHeight || 0, opts.marginalZone) ||
      rows.length < 4,
  );
  const usable = bodyRows.length >= 3 ? bodyRows : rows;
  return (
    weightedMedian(
      usable.map((line) => ({
        value: line.fontSize,
        weight: Math.max(1, line.text.length),
      })),
    ) || 12
  );
}

export function headingLevelForLine(line, bodySize, pageWidth, options = {}) {
  const opts = { ...DEFAULT_REFLOW_OPTIONS, ...options };
  if (!line || !bodySize || line.text.trim().length < 3) return 0;
  if (line.text.length > 160) return 0;
  const ratio = line.fontSize / bodySize;
  // A heading that fills the whole measure may just be a display line; still
  // allow it, but avoid classifying ordinary full-width body text that happens
  // to be in a slightly larger font.
  if (ratio >= opts.headingH2) return 2;
  if (ratio >= opts.headingH3 && line.width < pageWidth * 0.98) return 3;

  // Bold, short and without sentence punctuation: a section title set barely
  // above the body size (12 pt against 11 pt, as in many study guides). A bold
  // sentence ends with a period, and a run-in label ends with a colon, so both
  // stay paragraphs.
  if (line.bold) {
    const trimmed = line.text.trim();
    const short = trimmed.length <= 90 && line.width < pageWidth * 0.92;
    const noStop = !/[.!?;:,]$/.test(trimmed);
    if (short && noStop && ratio >= 0.98) {
      return ratio >= 1.25 ? 2 : 3;
    }
  }
  return 0;
}

/* ------------------------------------------------------------------ */
/* columns                                                            */
/* ------------------------------------------------------------------ */

function yRangesOverlap(leftLines, rightLines) {
  if (!leftLines.length || !rightLines.length) return 0;
  const aMin = Math.min(...leftLines.map((line) => line.y));
  const aMax = Math.max(...leftLines.map((line) => line.y));
  const bMin = Math.min(...rightLines.map((line) => line.y));
  const bMax = Math.max(...rightLines.map((line) => line.y));
  const overlap = Math.max(0, Math.min(aMax, bMax) - Math.max(aMin, bMin));
  const smaller = Math.min(aMax - aMin, bMax - bMin);
  return smaller > 0 ? overlap / smaller : overlap;
}

/**
 * Detect vertical gutters in the body text.
 * Returns { columns, gutters, isMultiColumn }.
 * `columns` are ordered left to right; each has { index, left, right }.
 */
export function detectColumns(lines, pageWidth, options = {}) {
  const opts = { ...DEFAULT_REFLOW_OPTIONS, ...options };
  const bodySize = options.bodySize || bodyFontSize(lines, options);
  const usable = (lines || []).filter(
    (line) =>
      line.width > pageWidth * 0.05 &&
      line.fontSize <= bodySize * 1.35 &&
      line.text.trim().length > 0,
  );

  const single = {
    columns: [{ index: 0, left: 0, right: pageWidth, lineCount: usable.length }],
    gutters: [],
    isMultiColumn: false,
  };
  if (usable.length < 6 || !(pageWidth > 0)) return single;

  // Full-width headings and closing paragraphs can run across every column
  // and hide the gutter from a simple x-projection. Use only narrow lines for
  // finding the gutter; fall back to all lines when that leaves too little.
  const narrow = usable.filter((line) => line.width <= pageWidth * 0.5);
  const projection = narrow.length >= 6 ? narrow : usable;

  // Count how many lines cover each bin instead of recording simple presence.
  // A caption or pull quote that crosses the gutter should not hide it: the
  // gutter stays a low-coverage band next to the densely covered columns.
  const bin = Math.max(1, pageWidth / 500);
  const binCount = Math.ceil(pageWidth / bin) + 2;
  const coverage = new Uint16Array(binCount);
  let minBin = Infinity;
  let maxBin = -Infinity;
  let peak = 0;

  for (const line of projection) {
    const start = clamp(Math.floor(line.x / bin), 0, binCount - 1);
    const end = clamp(Math.ceil((line.x + line.width) / bin), start + 1, binCount);
    for (let i = start; i < end; i += 1) {
      coverage[i] += 1;
      if (coverage[i] > peak) peak = coverage[i];
    }
    minBin = Math.min(minBin, start);
    maxBin = Math.max(maxBin, end - 1);
  }

  if (!Number.isFinite(minBin)) return single;

  const sparse = Math.max(1, Math.floor(peak * 0.2));
  const runs = [];
  let runStart = null;
  for (let i = minBin; i <= maxBin; i += 1) {
    if (coverage[i] <= sparse) {
      if (runStart === null) runStart = i;
    } else if (runStart !== null) {
      runs.push({ start: runStart * bin, end: i * bin });
      runStart = null;
    }
  }
  if (runStart !== null) runs.push({ start: runStart * bin, end: (maxBin + 1) * bin });

  const minSide = Math.max(2, Math.ceil(usable.length * 0.12));
  const gutters = [];
  for (const run of runs) {
    const width = run.end - run.start;
    if (width < pageWidth * opts.gutterRatio) continue;
    const left = projection.filter((line) => line.x + line.width <= run.start + 1);
    const right = projection.filter((line) => line.x >= run.end - 1);
    if (left.length < minSide || right.length < minSide) continue;
    if (yRangesOverlap(left, right) < 0.2) continue;
    gutters.push({ start: run.start, end: run.end, width });
  }

  if (!gutters.length) {
    const left = Math.min(...usable.map((line) => line.x));
    const right = Math.max(...usable.map((line) => line.x + line.width));
    return { columns: [{ index: 0, left, right, lineCount: usable.length }], gutters: [], isMultiColumn: false };
  }

  gutters.sort((a, b) => a.start - b.start);
  const boundaries = [Math.min(...projection.map((line) => line.x))];
  for (const gutter of gutters) {
    boundaries.push(gutter.start, gutter.end);
  }
  boundaries.push(Math.max(...projection.map((line) => line.x + line.width)));

  const columns = [];
  for (let i = 0; i + 1 < boundaries.length; i += 2) {
    const leftBoundary = boundaries[i];
    const rightBoundary = boundaries[i + 1];
    const regionLines = projection.filter((line) => {
      const center = line.x + line.width / 2;
      return center >= leftBoundary && center <= rightBoundary;
    });
    if (!regionLines.length) continue;
    columns.push({
      index: columns.length,
      left: Math.min(...regionLines.map((line) => line.x)),
      right: Math.max(...regionLines.map((line) => line.x + line.width)),
      lineCount: regionLines.length,
    });
  }

  if (columns.length < 2) return single;
  return { columns, gutters, isMultiColumn: true };
}

export function lineSpansGutter(line, gutters) {
  return (gutters || []).some(
    (gutter) => line.x < gutter.start - 2 && line.x + line.width > gutter.end + 2,
  );
}

export function isFullWidthLine(line, pageWidth, layout, options = {}) {
  const opts = { ...DEFAULT_REFLOW_OPTIONS, ...options };
  if (line.width >= pageWidth * opts.fullWidthRatio) return true;
  return lineSpansGutter(line, layout?.gutters);
}

function columnForLine(line, layout) {
  let best = null;
  let bestOverlap = 0;

  for (const column of layout.columns) {
    const left = Math.max(line.x, column.left);
    const right = Math.min(line.x + line.width, column.right);
    const overlap = Math.max(0, right - left);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = column;
    }
  }

  if (!best) {
    // A line outside all column extents (rare) goes to the nearest column.
    let bestDistance = Infinity;
    for (const column of layout.columns) {
      const distance = Math.min(
        Math.abs(line.x - column.left),
        Math.abs(line.x + line.width - column.right),
      );
      if (distance < bestDistance) {
        bestDistance = distance;
        best = column;
      }
    }
  }

  const ambiguous =
    best && line.width > 0 && bestOverlap / line.width < 0.55 && layout.columns.length > 1;
  return { column: best ? best.index : 0, ambiguous };
}

/**
 * Put lines into reading order for a page. Wide lines split the page into
 * horizontal bands; each band is read column by column, left to right.
 */
export function orderLines(lines, layout, pageWidth, options = {}) {
  const sorted = [...(lines || [])].sort((a, b) => b.y - a.y || a.x - b.x);

  if (!layout || layout.columns.length <= 1) {
    return sorted.map((line) => ({
      ...line,
      column: 0,
      band: 0,
      fullWidth: false,
      ambiguous: false,
    }));
  }

  const ordered = [];
  let buffer = [];
  let band = 0;

  const flush = () => {
    if (!buffer.length) return;
    const perColumn = new Map(layout.columns.map((column) => [column.index, []]));
    for (const line of buffer) {
      const { column, ambiguous } = columnForLine(line, layout);
      const bucket = perColumn.get(column) || perColumn.get(0);
      bucket.push({ ...line, ambiguous });
    }
    for (const column of layout.columns) {
      const bucket = perColumn.get(column.index) || [];
      bucket.sort((a, b) => b.y - a.y || a.x - b.x);
      for (const line of bucket) {
        ordered.push({ ...line, column: column.index, band, fullWidth: false });
      }
    }
    band += 1;
    buffer = [];
  };

  // Consecutive full-width lines (a wrapped heading or a paragraph set across
  // the page) share a band so they can be joined into one block later.
  let fullWidthBand = null;

  for (const line of sorted) {
    if (isFullWidthLine(line, pageWidth, layout, options)) {
      flush();
      if (fullWidthBand === null) fullWidthBand = band++;
      ordered.push({
        ...line,
        column: -1,
        band: fullWidthBand,
        fullWidth: true,
        ambiguous: false,
      });
    } else {
      fullWidthBand = null;
      buffer.push(line);
    }
  }
  flush();

  return ordered;
}

/* ------------------------------------------------------------------ */
/* paragraphs                                                         */
/* ------------------------------------------------------------------ */

/** Join two line strings, repairing line-end hyphenation. */
export function joinParagraphText(previousText, nextText, options = {}) {
  const opts = { ...DEFAULT_REFLOW_OPTIONS, ...options };
  const previous = String(previousText || '').replace(/\s+$/u, '');
  const next = String(nextText || '')
    .replace(/^\s+/u, '')
    .replace(/\s+$/u, '');

  if (!previous) return next;
  if (!next) return previous;

  if (previous.endsWith('\u00AD')) return previous.slice(0, -1) + next;

  if (HYPHEN_END.test(previous)) {
    if (LOWERCASE_START.test(next) && opts.joinHyphenation) {
      return previous.slice(0, -1) + next;
    }
    // Preserve the real hyphen (State-of-the- / Art), and do not insert a
    // space after it.
    return previous + next;
  }

  if (CLOSING_PUNCT_START.test(next)) {
    return previous + next;
  }

  return previous + ' ' + next;
}

function columnGeometry(orderedLines) {
  const lefts = new Map();
  const rights = new Map();
  for (const line of orderedLines) {
    if (line.column < 0 || line.image || line.table) continue;
    if (!lefts.has(line.column)) {
      lefts.set(line.column, []);
      rights.set(line.column, []);
    }
    lefts.get(line.column).push(line.x);
    rights.get(line.column).push(line.x + line.width);
  }
  const result = new Map();
  for (const [column, values] of lefts) {
    result.set(column, {
      left: median(values),
      right: Math.max(...rights.get(column)),
    });
  }
  return result;
}

function startsNewParagraph(current, line, bodySize, geometry, options) {
  const opts = { ...DEFAULT_REFLOW_OPTIONS, ...options };
  const previous = current.last;
  if (!previous) return true;
  if (line.column !== previous.column || line.band !== previous.band) return true;
  if (line.fontSize < bodySize * opts.smallText && !current.small) return true;

  const gap = previous.y - line.y;
  if (gap < 0) return true;

  const size = Math.max(previous.fontSize, line.fontSize);
  const leading = size * 1.2;
  if (gap > leading * opts.paragraphGap) return true;

  const geo = geometry.get(line.column);
  const indent = geo ? line.x - geo.left : 0;
  const indentStep = line.x - previous.x;
  // Only the first line of an indented paragraph steps in; its continuation
  // lines share the indent with the line above and must not start a new block.
  if (
    indent > opts.indentEm * line.fontSize &&
    indentStep > opts.indentEm * line.fontSize
  ) {
    return true;
  }

  const columnWidth = geo ? Math.max(geo.right - geo.left, 1) : line.width;
  const previousIsShort = previous.width < columnWidth * opts.shortLineRatio;
  if (previousIsShort && SENTENCE_END.test(previous.text)) return true;

  // End-of-sentence plus even a modest extra leading is a strong paragraph
  // hint in books where paragraph spacing replaces indentation.
  if (SENTENCE_END.test(previous.text) && gap > leading * 1.3) return true;

  return false;
}

/**
 * Table-of-contents pages set the title and the page number as separate text
 * runs on the same baseline, or join them with dot leaders. Collect those
 * pairs and group continuous runs of at least three entries. Anything shorter
 * is ordinary text and is left alone.
 */
function collectTocRuns(orderedLines, pageWidth) {
  const entries = [];
  const consumed = new Set();

  for (let i = 0; i < orderedLines.length; i += 1) {
    if (consumed.has(i)) continue;
    const line = orderedLines[i];
    if (!line || line.image || !line.text || !line.text.trim()) continue;

    const next = orderedLines[i + 1];
    const numeric = next && !next.image ? next.text.trim() : '';
    const sameBaseline =
      next && Math.abs(next.y - line.y) <= Math.max(1.5, line.fontSize * 0.2);
    // The number must sit in the right-hand part of the measure with a clear
    // gap after the title, so a numeric table column is not mistaken for a
    // contents page.
    const gap = next ? next.x - (line.x + line.width) : 0;
    const rightAligned =
      next && next.x > pageWidth * 0.72 && gap > pageWidth * 0.06;

    if (
      /^\d{1,4}$/.test(numeric) &&
      sameBaseline &&
      rightAligned &&
      !/^\d{1,4}$/.test(line.text.trim())
    ) {
      entries.push({
        index: i,
        nextIndex: i + 1,
        title: line.text,
        page: numeric,
        x: line.x,
        y: line.y,
        fontSize: line.fontSize,
        bold: Boolean(line.bold),
        column: line.column,
        band: line.band,
      });
      consumed.add(i);
      consumed.add(i + 1);
      continue;
    }

    const leaders = line.text.match(
      /^(.*\S)\s*(?:\.{2,}|\u2026{2,}|\u00b7{2,}|_{2,})\s*(\d{1,4})$/u,
    );
    if (leaders && leaders[1].trim().length >= 2) {
      entries.push({
        index: i,
        nextIndex: i,
        title: leaders[1],
        page: leaders[2],
        x: line.x,
        y: line.y,
        fontSize: line.fontSize,
        bold: Boolean(line.bold),
        column: line.column,
        band: line.band,
      });
      consumed.add(i);
    }
  }

  const runs = [];
  let current = [];
  for (const entry of entries) {
    const previous = current[current.length - 1];
    const continuous = previous ? entry.index === previous.nextIndex + 1 : true;
    const sameFlow = previous
      ? previous.column === entry.column && previous.band === entry.band
      : true;
    const gap = previous ? previous.y - entry.y : 0;
    const closeEnough = previous
      ? gap > 0 && gap <= Math.max(28, entry.fontSize * 3)
      : true;

    if (previous && continuous && sameFlow && closeEnough) {
      current.push(entry);
    } else {
      if (current.length >= 3) runs.push(current);
      current = [entry];
    }
  }
  if (current.length >= 3) runs.push(current);
  return runs;
}

function tocItems(run) {
  const xs = [];
  for (const entry of run) {
    if (!xs.some((value) => Math.abs(value - entry.x) <= 2)) xs.push(entry.x);
  }
  xs.sort((a, b) => a - b);

  return run.map((entry) => ({
    title: entry.title
      .replace(/[\s.\u00b7\u2026_]{2,}$/u, '')
      .replace(/\s+/g, ' ')
      .trim(),
    page: entry.page,
    level: Math.min(3, Math.max(0, xs.findIndex((value) => Math.abs(value - entry.x) <= 2))),
    bold: entry.bold,
  }));
}

/**
 * Turn ordered lines into heading/paragraph blocks.
 */
export function buildBlocks(orderedLines, context = {}) {
  const opts = { ...DEFAULT_REFLOW_OPTIONS, ...(context.options || {}) };
  const pageWidth = context.pageWidth || 612;
  const pageNumber = context.pageNumber || 1;
  const bodySize = context.bodySize || bodyFontSize(orderedLines, opts);
  const geometry = columnGeometry(orderedLines);

  const blocks = [];
  let current = null;

  // Table-of-contents pages become a structured block instead of a wall of
  // merged lines: title left, page number right, dotted leader between.
  const tocStart = new Map();
  const tocSkip = new Set();
  for (const run of collectTocRuns(orderedLines, pageWidth)) {
    const block = {
      type: 'toc',
      level: 0,
      text: '',
      page: pageNumber,
      column: run[0].column,
      band: run[0].band,
      small: false,
      fontSize: run[0].fontSize,
      items: tocItems(run),
    };
    tocStart.set(run[0].index, block);
    for (const entry of run) {
      tocSkip.add(entry.index);
      tocSkip.add(entry.nextIndex);
    }
  }

  const flush = () => {
    if (!current) return;
    if (current.type === 'list') {
      if (current.items.length) {
        blocks.push({
          type: 'list',
          level: 0,
          text: '',
          page: pageNumber,
          column: current.column,
          band: current.band,
          small: Boolean(current.small),
          fontSize: current.fontSize,
          items: current.items.map((entry) => ({
            level: entry.level,
            ordered: entry.ordered,
            marker: entry.marker,
            number: entry.number,
            text: entry.text.replace(/\s+/g, ' ').trim(),
          })),
        });
      }
      current = null;
      return;
    }
    blocks.push({
      type: current.type,
      level: current.level || 0,
      text: current.text.replace(/\s+/g, ' ').trim(),
      page: pageNumber,
      column: current.column,
      band: current.band,
      small: Boolean(current.small),
      fontSize: current.fontSize,
    });
    current = null;
  };

  for (let lineIndex = 0; lineIndex < orderedLines.length; lineIndex += 1) {
    if (tocSkip.has(lineIndex)) {
      const tocBlock = tocStart.get(lineIndex);
      if (tocBlock) {
        flush();
        blocks.push(tocBlock);
      }
      continue;
    }
    const line = orderedLines[lineIndex];
    if (line.table) {
      flush();
      const table = line.tableData;
      blocks.push({
        type: 'table',
        level: 0,
        text: '',
        page: pageNumber,
        column: line.column,
        band: line.band,
        small: false,
        fontSize: bodySize,
        rows: table.rows,
        columns: table.columns,
        header: Boolean(table.header),
      });
      continue;
    }
    if (line.image) {
      flush();
      blocks.push({
        type: 'image',
        level: 0,
        text: '',
        page: pageNumber,
        column: line.column,
        band: line.band,
        small: false,
        fontSize: bodySize,
        imageId: line.imageId,
        image: line.imageData,
      });
      continue;
    }
    if (!line.text) continue;

    const marker = detectListMarker(line.text);
    if (marker) {
      const continuesList =
        current &&
        current.type === 'list' &&
        current.column === line.column &&
        current.band === line.band;
      if (!continuesList) {
        flush();
        current = {
          type: 'list',
          items: [],
          column: line.column,
          band: line.band,
          small: line.fontSize < bodySize * opts.smallText,
          fontSize: line.fontSize,
          last: line,
        };
      }
      current.items.push({
        level: nextListLevel(current.items, line),
        ordered: marker.ordered,
        marker: marker.marker,
        number: marker.number,
        text: marker.text,
        x: line.x,
        textX: null,
      });
      current.last = line;
      continue;
    }

    // A wrapped list item continues at the item's text indent, not at the
    // bullet. Paragraphs after a list start at the column edge, so they close
    // the list instead of being swallowed by the last item.
    if (current && current.type === 'list') {
      const lastItem = current.items[current.items.length - 1];
      const gap = current.last.y - line.y;
      const size = Math.max(current.last.fontSize, line.fontSize);
      const leading = size * 1.2;
      const indented = lastItem.textX
        ? line.x >= lastItem.textX - line.fontSize * 0.5
        : line.x > lastItem.x + line.fontSize * 0.8;
      const sameFlow = current.column === line.column && current.band === line.band;
      const heading = headingLevelForLine(line, bodySize, pageWidth, opts);
      if (
        sameFlow &&
        !heading &&
        gap >= 0 &&
        gap <= leading * opts.paragraphGap &&
        indented
      ) {
        lastItem.text = joinParagraphText(lastItem.text, line.text, opts);
        if (!lastItem.textX) lastItem.textX = line.x;
        current.last = line;
        continue;
      }
      flush();
    }

    const level = headingLevelForLine(line, bodySize, pageWidth, opts);

    if (level) {
      const continuesHeading =
        current &&
        current.type === 'heading' &&
        current.level === level &&
        current.column === line.column &&
        current.band === line.band &&
        current.last.y - line.y <= line.fontSize * 1.6;

      if (continuesHeading) {
        current.text = joinParagraphText(current.text, line.text, opts);
        current.last = line;
      } else {
        flush();
        current = {
          type: 'heading',
          level,
          text: line.text,
          column: line.column,
          band: line.band,
          small: false,
          fontSize: line.fontSize,
          last: line,
        };
      }
      continue;
    }

    const small = line.fontSize < bodySize * opts.smallText;
    const continuesParagraph =
      current &&
      current.type === 'paragraph' &&
      current.column === line.column &&
      current.band === line.band &&
      Boolean(current.small) === small &&
      !startsNewParagraph(current, line, bodySize, geometry, opts);

    if (continuesParagraph) {
      current.text = joinParagraphText(current.text, line.text, opts);
      current.last = line;
    } else {
      flush();
      current = {
        type: 'paragraph',
        level: 0,
        text: line.text,
        column: line.column,
        band: line.band,
        small,
        fontSize: line.fontSize,
        last: line,
      };
    }
  }

  flush();
  return blocks;
}

/* ------------------------------------------------------------------ */
/* top level                                                          */
/* ------------------------------------------------------------------ */

function emptyQuality(scanned, reasons = []) {
  return {
    scanned,
    lowQuality: scanned || reasons.length > 0,
    score: scanned ? 0 : 0.5,
    reasons,
  };
}

/**
 * Reflow lines that have already been extracted (shape: groupLines output).
 * Pure and cheap; used both by the reader and by tests.
 */
export function reflowLines(input = {}) {
  const {
    lines = [],
    pageNumber = 1,
    pageWidth = 612,
    pageHeight = 792,
    marginalSignatures,
    images = [],
    options = {},
  } = input;

  const opts = { ...DEFAULT_REFLOW_OPTIONS, ...options };
  const rawLines = Array.isArray(lines) ? lines : [];
  const tables = (Array.isArray(input.tables) ? input.tables : []).filter(
    (table) => table && Array.isArray(table.rows) && table.rows.length,
  );

  // Table text is represented by the table block, not by loose lines. Drop
  // those lines before column detection so the table's internal gutters are
  // not mistaken for page columns.
  const insideTable = (line) => {
    if (!tables.length) return false;
    const cx = line.x + (line.width || 0) / 2;
    const cy = line.y + (line.fontSize || 10) * 0.35;
    return tables.some(
      (table) =>
        cx >= table.x - 2 &&
        cx <= table.x + table.width + 2 &&
        cy >= table.y - 2 &&
        cy <= table.y + table.height + 2,
    );
  };

  const meaningful = rawLines.filter(
    (line) => line.text && line.text.trim().length > 0 && !insideTable(line),
  );

  const tableLines = tables.map((table) => ({
    text: '',
    x: table.x,
    y: table.y + table.height,
    width: table.width,
    fontSize: 12,
    table: true,
    tableData: table,
  }));

  // Images become zero-text lines for ordering. Their y is the top edge so a
  // figure sits before the paragraph that follows it on the page. They are
  // built before the text check so an image-only page still produces blocks.
  const imageLines = (Array.isArray(images) ? images : [])
    .filter(
      (image) =>
        image &&
        Number.isFinite(image.x) &&
        Number.isFinite(image.y) &&
        Number.isFinite(image.width) &&
        Number.isFinite(image.height) &&
        image.width > 0 &&
        image.height > 0,
    )
    .map((image) => ({
      text: '',
      x: image.x,
      y: image.y + image.height,
      width: image.width,
      fontSize: 12,
      image: true,
      imageId: image.id,
      imageData: image,
    }));

  if (meaningful.length === 0) {
    if (imageLines.length || tableLines.length) {
      const emptyLayout = { columns: [], gutters: [], isMultiColumn: false };
      const ordered = orderLines(
        [...imageLines, ...tableLines],
        emptyLayout,
        pageWidth,
        opts,
      );
      const blocks = buildBlocks(ordered, {
        bodySize: 12,
        pageWidth,
        pageNumber,
        options: opts,
      });
      const tableOnly = tableLines.length > 0;
      return {
        blocks,
        layout: emptyLayout,
        quality: emptyQuality(
          !tableOnly,
          tableOnly ? [] : ['No text layer was found on this page.'],
        ),
        stats: {
          lineCount: 0,
          blockCount: blocks.length,
          imageCount: imageLines.length,
          tableCount: tableLines.length,
          charCount: 0,
        },
      };
    }
    return {
      blocks: [],
      layout: { columns: [], gutters: [], isMultiColumn: false },
      quality: emptyQuality(true, ['No text layer was found on this page.']),
      stats: { lineCount: 0, blockCount: 0, imageCount: 0, charCount: 0 },
    };
  }

  // Estimate body size from the unfiltered page: marginal removal must not
  // mistake a chapter title or heading for a running head.
  const bodySize = bodyFontSize(meaningful, { ...opts, pageHeight });

  const filtered = stripMarginalLines(
    meaningful,
    pageHeight,
    marginalSignatures,
    { ...opts, bodySize },
  );

  const tableChars = tables.reduce(
    (sum, table) =>
      sum +
      table.rows.reduce(
        (rowSum, row) =>
          rowSum + row.reduce((cellSum, cell) => cellSum + String(cell.text || '').length, 0),
        0,
      ),
    0,
  );
  const charCount = filtered.reduce((sum, line) => sum + line.chars, 0) + tableChars;
  if ((!filtered.length && !tableLines.length) || charCount < 2) {
    return {
      blocks: [],
      layout: { columns: [], gutters: [], isMultiColumn: false },
      quality: emptyQuality(true, ['This page contains only a page number or running head.']),
      stats: { lineCount: 0, blockCount: 0, imageCount: 0, charCount },
    };
  }

  const layout = filtered.length
    ? detectColumns(filtered, pageWidth, { ...opts, bodySize })
    : { columns: [], gutters: [], isMultiColumn: false };

  const ordered = orderLines(
    [...filtered, ...imageLines, ...tableLines],
    layout,
    pageWidth,
    opts,
  );
  const blocks = buildBlocks(ordered, {
    bodySize,
    pageWidth,
    pageNumber,
    options: opts,
  });

  const ambiguous = ordered.filter((line) => line.ambiguous).length;
  const ambiguousRatio = ordered.length ? ambiguous / ordered.length : 0;
  const reasons = [];
  if (filtered.length < 5 && !tableLines.length) {
    reasons.push('Very little text was found on this page.');
  }
  if (layout.columns.length > 4) {
    reasons.push('An unusually complex column layout was detected.');
  }
  if (ambiguousRatio > 0.2) {
    reasons.push('Some lines could not be assigned to a column with confidence.');
  }

  const score = clamp(
    1 - Math.min(0.6, ambiguousRatio) - (filtered.length < 5 ? 0.25 : 0),
    0.1,
    1,
  );

  return {
    blocks,
    layout,
    quality: {
      scanned: false,
      lowQuality: reasons.length > 0,
      score,
      reasons,
    },
    stats: {
      lineCount: filtered.length,
      blockCount: blocks.length,
      imageCount: imageLines.length,
      tableCount: tableLines.length,
      charCount,
      columns: layout.columns.length,
      ambiguousRatio,
    },
    bodySize,
  };
}

/**
 * Full page pipeline: raw pdf.js items -> lines -> blocks.
 */
export function reflowPage(input = {}) {
  const {
    items = [],
    pageNumber = 1,
    pageWidth = 612,
    pageHeight = 792,
    marginalSignatures,
    options = {},
  } = input;

  const lines = groupLines(items, options);
  const result = reflowLines({
    lines,
    pageNumber,
    pageWidth,
    pageHeight,
    marginalSignatures,
    options,
  });

  return { ...result, lines };
}

/** Plain text of a page for search/indexing. */
export function blocksToText(blocks) {
  return (blocks || [])
    .map((block) => block.text)
    .join('\n\n')
    .trim();
}
