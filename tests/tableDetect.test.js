import { describe, expect, it } from 'vitest';
import { detectTables, extractRules } from '../src/tableDetect.js';

function item(text, x, y, { width = text.length * 5, height = 10, bold = false } = {}) {
  return {
    str: text,
    x,
    y,
    width,
    height,
    transform: [height, 0, 0, height, x, y],
    bold,
  };
}

function gridRules(xs, ys) {
  const rules = [];
  for (const x of xs) {
    rules.push({ kind: 'v', x, y1: Math.min(...ys), y2: Math.max(...ys) });
  }
  for (const y of ys) {
    rules.push({ kind: 'h', y, x1: Math.min(...xs), x2: Math.max(...xs) });
  }
  return rules;
}

describe('detectTables', () => {
  it('turns a ruled grid into rows and columns', () => {
    const xs = [36, 200, 360, 520];
    const ys = [160, 130, 100];
    const tables = detectTables({
      rules: gridRules(xs, ys),
      items: [
        item('Model', 40, 150),
        item('Task', 204, 150),
        item('Notes', 364, 150),
        item('Lambda', 40, 120),
        item('Validate', 204, 120),
        item('Check output', 364, 120),
      ],
      pageWidth: 612,
      pageHeight: 792,
    });

    expect(tables).toHaveLength(1);
    expect(tables[0].rows).toEqual([
      [
        { text: 'Model', bold: false },
        { text: 'Task', bold: false },
        { text: 'Notes', bold: false },
      ],
      [
        { text: 'Lambda', bold: false },
        { text: 'Validate', bold: false },
        { text: 'Check output', bold: false },
      ],
    ]);
    expect(tables[0].columns).toBe(3);
  });

  it('joins wrapped lines and split glyph runs inside a cell', () => {
    const tables = detectTables({
      rules: gridRules([36, 200, 360], [160, 130, 100]),
      items: [
        item('Amazon EventBridge Schema', 40, 150),
        item('Registry', 40, 136),
        item('Validation work', 204, 150, { width: 97 }),
        item('fl', 301, 150, { width: 6 }),
        item('ows', 307, 150, { width: 20 }),
      ],
      pageWidth: 612,
      pageHeight: 792,
    });

    expect(tables[0].rows[0][0].text).toBe('Amazon EventBridge Schema Registry');
    expect(tables[0].rows[0][1].text).toBe('Validation workflows');
  });

  it('keeps blank-line paragraphs and bold labels inside a cell', () => {
    const tables = detectTables({
      rules: gridRules([36, 200, 360], [160, 120, 40]),
      items: [
        item('Model', 40, 150, { bold: true }),
        item('Task', 204, 150, { bold: true }),
        item('First paragraph line', 40, 110),
        item('Metrics:', 40, 83, { width: 38, bold: true }),
        item('Accuracy scores', 40, 69),
        item('Best For:', 40, 42, { width: 44, bold: true }),
        item('checks', 87, 42, { width: 30 }),
        item('Validate', 204, 110),
      ],
      pageWidth: 612,
      pageHeight: 792,
    });

    const cell = tables[0].rows[1][0];
    expect(cell.text).toBe(
      'First paragraph line Metrics: Accuracy scores Best For: checks',
    );
    expect(cell.paragraphs.map((paragraph) => paragraph.text)).toEqual([
      'First paragraph line',
      'Metrics: Accuracy scores',
      'Best For: checks',
    ]);
    // The line-break space stays with the last run of the line it ends.
    expect(cell.paragraphs[1].runs.map((run) => [run.text, run.bold])).toEqual([
      ['Metrics: ', true],
      ['Accuracy scores', false],
    ]);
    expect(cell.paragraphs[2].runs.map((run) => [run.text, run.bold])).toEqual([
      ['Best For:', true],
      [' checks', false],
    ]);
    // Labels are bold, but the cell is not a bold header cell.
    expect(cell.bold).toBe(false);
  });

  it('marks a fully bold first row as a header', () => {
    const tables = detectTables({
      rules: gridRules([36, 200, 360], [160, 130, 100]),
      items: [
        item('Model', 40, 150, { bold: true }),
        item('Task', 204, 150, { bold: true }),
        item('Lambda', 40, 120),
        item('Validate', 204, 120),
      ],
      pageWidth: 612,
      pageHeight: 792,
    });

    expect(tables[0].header).toBe(true);
  });

  it('finds a table drawn only as cell rectangles', () => {
    const rects = [];
    for (const y of [100, 130]) {
      for (const x of [36, 200]) {
        rects.push({ x, y, width: 164, height: 30 });
      }
    }
    const tables = detectTables({
      rects,
      items: [
        item('Left', 40, 145),
        item('Right', 204, 145),
        item('One', 40, 115),
        item('Two', 204, 115),
      ],
      pageWidth: 612,
      pageHeight: 792,
    });

    expect(tables).toHaveLength(1);
    expect(tables[0].rows.map((row) => row.map((cell) => cell.text))).toEqual([
      ['Left', 'Right'],
      ['One', 'Two'],
    ]);
  });

  it('ignores rules that do not form a grid', () => {
    const tables = detectTables({
      rules: [
        { kind: 'h', y: 500, x1: 36, x2: 400 },
        { kind: 'h', y: 480, x1: 36, x2: 400 },
      ],
      items: [item('Just a rule', 40, 490)],
      pageWidth: 612,
      pageHeight: 792,
    });

    expect(tables).toEqual([]);
  });

  it('does not create empty rows when cell boxes have different heights', () => {
    const rules = gridRules([36, 200, 360, 520], [160, 130, 100]);
    const rects = [
      { x: 36, y: 130, width: 164, height: 30 },
      { x: 200, y: 130, width: 160, height: 30 },
      { x: 360, y: 130, width: 160, height: 30 },
      { x: 36, y: 100, width: 164, height: 30 },
      { x: 200, y: 100, width: 160, height: 30 },
      { x: 360, y: 100, width: 160, height: 30 },
    ];
    const tables = detectTables({
      rules,
      rects,
      items: [
        item('A', 40, 150),
        item('B', 204, 150),
        item('C', 364, 150),
        item('D', 40, 120),
        item('E', 204, 120),
        item('F', 364, 120),
      ],
      pageWidth: 612,
      pageHeight: 792,
    });

    expect(tables[0].rows).toHaveLength(2);
  });
});

describe('extractRules', () => {
  const OPS = {
    save: 1,
    restore: 2,
    transform: 3,
    constructPath: 4,
    rectangle: 5,
    moveTo: 6,
    lineTo: 7,
    closePath: 8,
    curveTo: 9,
    curveTo2: 10,
    curveTo3: 11,
  };

  it('reads horizontal and vertical strokes', () => {
    const { rules } = extractRules(
      [OPS.constructPath, OPS.constructPath],
      [
        [[OPS.moveTo, OPS.lineTo], [36, 500, 400, 500]],
        [[OPS.moveTo, OPS.lineTo], [36, 400, 36, 500]],
      ],
      OPS,
      { pageWidth: 612, pageHeight: 792 },
    );

    expect(rules).toEqual([
      { kind: 'h', y: 500, x1: 36, x2: 400 },
      { kind: 'v', x: 36, y1: 400, y2: 500 },
    ]);
  });

  it('reads rectangles as cell candidates', () => {
    const { rects } = extractRules(
      [OPS.constructPath],
      [[[OPS.rectangle], [36, 100, 160, 30]]],
      OPS,
      { pageWidth: 612, pageHeight: 792 },
    );

    expect(rects).toEqual([{ x: 36, y: 100, width: 160, height: 30 }]);
  });
});
