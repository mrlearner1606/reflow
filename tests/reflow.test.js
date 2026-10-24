import { describe, expect, it } from 'vitest';
import {
  addPageMarginals,
  bodyFontSize,
  buildBlocks,
  createMarginalIndex,
  detectColumns,
  detectListMarker,
  findRepeatedMarginals,
  groupLines,
  isPageNumberLine,
  joinParagraphText,
  lineSignature,
  orderLines,
  reflowLines,
  reflowPage,
  stripMarginalLines,
} from '../src/reflow.js';

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

/** Build a raw pdf.js-like item with its baseline at y. */
function item(text, x, y, fontSize = 10, width = null, extra = {}) {
  const w = width ?? text.length * fontSize * 0.5;
  return {
    str: text,
    transform: [fontSize, 0, 0, fontSize, x, y],
    width: w,
    height: fontSize,
    fontName: 'Helvetica',
    ...extra,
  };
}

function line(text, x, y, width, fontSize = 10, extra = {}) {
  return {
    text,
    x,
    y,
    width,
    fontSize,
    chars: text.length,
    ...extra,
  };
}

/* ------------------------------------------------------------------ */
/* line grouping                                                      */
/* ------------------------------------------------------------------ */

describe('groupLines', () => {
  it('groups words sharing a baseline into one line', () => {
    const lines = groupLines([
      item('Hello', 72, 700, 10, 26),
      item('world', 105, 700, 10, 28),
      item('Next line', 72, 688, 10, 45),
    ]);

    expect(lines).toHaveLength(2);
    expect(lines[0].text).toBe('Hello world');
    expect(lines[1].text).toBe('Next line');
    expect(lines[0].x).toBe(72);
    expect(lines[0].width).toBe(61);
  });

  it('splits same-baseline runs across a wide gutter', () => {
    const lines = groupLines([
      item('Left column text', 72, 700, 10, 140),
      item('Right column text', 330, 700, 10, 150),
    ]);

    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.text)).toEqual(['Left column text', 'Right column text']);
    expect(lines[0].x).toBe(72);
    expect(lines[1].x).toBe(330);
  });

  it('inserts spaces across gaps but not inside words', () => {
    // "exam" + "ple" drawn as separate runs within one word, then a real gap.
    const lines = groupLines([
      item('exam', 72, 700, 10, 24),
      item('ple', 96, 700, 10, 15),
      item('text', 128, 700, 10, 20),
    ]);

    expect(lines[0].text).toBe('example text');
  });

  it('accepts small baseline jitter within tolerance', () => {
    const lines = groupLines([
      item('One', 72, 700, 10, 18),
      item('line', 94, 699.4, 10, 18),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe('One line');
  });

  it('does not merge normal consecutive baselines', () => {
    const lines = groupLines([
      item('First', 72, 700, 10, 25),
      item('Second', 72, 688, 10, 32),
    ]);
    expect(lines.map((l) => l.text)).toEqual(['First', 'Second']);
  });

  it('drops empty and rotated runs', () => {
    const lines = groupLines([
      item('  ', 72, 700),
      { str: 'watermark', transform: [7, 7, -7, 7, 300, 300], width: 80, height: 10 },
      item('real text', 72, 650),
    ]);
    expect(lines.map((l) => l.text)).toEqual(['real text']);
  });
});

/* ------------------------------------------------------------------ */
/* hyphenation                                                        */
/* ------------------------------------------------------------------ */

describe('hyphenation joining', () => {
  it('removes a line-end hyphen before a lowercase continuation', () => {
    expect(joinParagraphText('This is an exam-', 'ple of reflow.')).toBe(
      'This is an example of reflow.',
    );
  });

  it('keeps the hyphen when the continuation starts uppercase', () => {
    expect(joinParagraphText('State-of-the-', 'Art design')).toBe('State-of-the-Art design');
  });

  it('joins soft hyphens', () => {
    expect(joinParagraphText('co\u00AD', 'operate')).toBe('cooperate');
  });

  it('uses a space for normal line ends', () => {
    expect(joinParagraphText('A normal line', 'continues here.')).toBe(
      'A normal line continues here.',
    );
  });

  it('does not insert a space before closing punctuation', () => {
    expect(joinParagraphText('a list', ', and more')).toBe('a list, and more');
  });

  it('can be disabled', () => {
    expect(
      joinParagraphText('exam-', 'ple', { joinHyphenation: false }),
    ).toBe('exam-ple');
  });
});

/* ------------------------------------------------------------------ */
/* paragraphs and headings                                            */
/* ------------------------------------------------------------------ */

describe('paragraph detection', () => {
  it('splits paragraphs on vertical gaps', () => {
    const lines = [
      line('First paragraph starts here and runs long enough to wrap', 72, 700, 360),
      line('and continues on this line as part of the same paragraph.', 72, 686, 370),
      line('A second paragraph begins after a clear gap.', 72, 650, 300),
      line('It also wraps onto a second line.', 72, 636, 240),
    ];

    const blocks = buildBlocks(lines, {
      bodySize: 10,
      pageWidth: 612,
      pageNumber: 3,
      options: { removeHeaderFooter: false, pageHeight: 792 },
    });

    expect(blocks).toHaveLength(2);
    expect(blocks[0].text).toContain('First paragraph');
    expect(blocks[0].text).toContain('same paragraph.');
    expect(blocks[1].text).toBe(
      'A second paragraph begins after a clear gap. It also wraps onto a second line.',
    );
    expect(blocks[0].page).toBe(3);
  });

  it('splits on first-line indentation', () => {
    const lines = [
      line('The paragraph fills the measure completely and ends well.', 72, 700, 400),
      line('The next line is also long but starts at the left margin.', 72, 686, 395),
      line('An indented new paragraph starts after the indent.', 84, 660, 300),
      line('And it continues here with more words on the next line.', 72, 646, 380),
    ];

    const blocks = buildBlocks(lines, { bodySize: 10, pageWidth: 612 });
    expect(blocks).toHaveLength(2);
    expect(blocks[1].text).toMatch(/^An indented/);
  });

  it('detects headings by relative font size', () => {
    const lines = [
      line('Chapter Two', 72, 740, 140, 20),
      line('Body text begins here and is set in the normal size.', 72, 700, 300, 10),
      line('It continues on the next line with more body copy.', 72, 686, 320, 10),
      line('A Section Heading', 72, 660, 140, 13),
      line('More body text follows the section heading here.', 72, 630, 300, 10),
    ];
    const blocks = buildBlocks(lines, { bodySize: 10, pageWidth: 612 });

    expect(blocks[0].type).toBe('heading');
    expect(blocks[0].level).toBe(2);
    expect(blocks[0].text).toBe('Chapter Two');
    expect(blocks[2].type).toBe('heading');
    expect(blocks[2].level).toBe(3);
  });

  it('marks small print as its own block style', () => {
    const lines = [
      line('Normal body copy fills this line and continues onwards.', 72, 500, 350, 10),
      line('Normal body copy continues on the following line too.', 72, 486, 340, 10),
      line('1. A footnote set in smaller type.', 72, 120, 220, 8),
      line('2. Another footnote line.', 72, 108, 160, 8),
    ];
    const blocks = buildBlocks(lines, { bodySize: 10, pageWidth: 612 });

    expect(blocks.at(-1).small).toBe(true);
    const lastText = blocks.at(-1).items?.[0].text ?? blocks.at(-1).text;
    expect(lastText).toContain('footnote');
  });
});

/* ------------------------------------------------------------------ */
/* columns                                                            */
/* ------------------------------------------------------------------ */

describe('column detection and reading order', () => {
  const twoColumnLines = [
    line('A Heading Across Both Columns', 72, 740, 460, 18),
    line('Left column line one with several words.', 72, 700, 200),
    line('Left column line two with several words.', 72, 686, 200),
    line('Left column line three with words.', 72, 672, 190),
    line('Right column line one with words.', 340, 700, 200),
    line('Right column line two with words.', 340, 686, 200),
    line('Right column line three with words.', 340, 672, 195),
  ];

  it('finds a gutter and two columns', () => {
    const layout = detectColumns(twoColumnLines, 612, { bodySize: 10 });
    expect(layout.isMultiColumn).toBe(true);
    expect(layout.columns).toHaveLength(2);
    expect(layout.columns[0].left).toBe(72);
    expect(layout.columns[1].left).toBe(340);
  });

  it('reads the full-width heading, then the left column, then the right', () => {
    const layout = detectColumns(twoColumnLines, 612, { bodySize: 10 });
    const ordered = orderLines(twoColumnLines, layout, 612);

    expect(ordered).toHaveLength(7);
    expect(ordered[0].text).toMatch(/^A Heading/);
    expect(ordered[1].text).toMatch(/^Left column line one/);
    expect(ordered[2].text).toMatch(/^Left column line two/);
    expect(ordered[3].text).toMatch(/^Left column line three/);
    expect(ordered[4].text).toMatch(/^Right column line one/);
    expect(ordered[6].text).toMatch(/^Right column line three/);
  });

  it('finds the gutter when full-width body lines bridge it', () => {
    const lines = [
      line('Left column line one with words.', 72, 700, 200),
      line('Left column line two with words.', 72, 686, 200),
      line('Left column line three with words.', 72, 672, 195),
      line('Left column line four with words.', 72, 658, 198),
      line('Left column line five with words.', 72, 644, 192),
      line('Right column line one with words.', 340, 700, 200),
      line('Right column line two with words.', 340, 686, 200),
      line('Right column line three with words.', 340, 672, 196),
      line('Right column line four with words.', 340, 658, 194),
      line('Right column line five with words.', 340, 644, 190),
      line('A full-width paragraph line that runs across the gutter.', 72, 620, 460),
      line('Another full-width line continues across the gutter.', 72, 606, 430),
    ];

    const layout = detectColumns(lines, 612, { bodySize: 10 });
    expect(layout.isMultiColumn).toBe(true);
    expect(layout.columns).toHaveLength(2);
    expect(layout.columns[0].left).toBe(72);
    expect(layout.columns[1].left).toBe(340);

    const ordered = orderLines(lines, layout, 612);
    expect(ordered[10].text).toMatch(/^A full-width/);
    expect(ordered[11].text).toMatch(/^Another full-width/);
  });

  it('joins consecutive full-width lines under a two-column layout', () => {
    const result = reflowLines({
      lines: [
        line('Left column line one with words.', 72, 700, 200),
        line('Left column line two with words.', 72, 686, 200),
        line('Left column line three with words.', 72, 672, 195),
        line('Right column line one with words.', 340, 700, 200),
        line('Right column line two with words.', 340, 686, 200),
        line('Right column line three with words.', 340, 672, 196),
        line('A full-width heading across both columns', 72, 620, 460, 18),
        line('A wide paragraph line that crosses the gutter.', 72, 590, 450, 10),
        line('Its second wide line continues below it.', 72, 576, 430, 10),
      ],
      pageWidth: 612,
      pageHeight: 792,
      options: { removeHeaderFooter: false },
    });

    const last = result.blocks[result.blocks.length - 1];
    expect(last.type).toBe('paragraph');
    expect(last.text).toBe(
      'A wide paragraph line that crosses the gutter. Its second wide line continues below it.',
    );
    expect(result.blocks.some((b) => b.type === 'heading' && /full-width heading/.test(b.text))).toBe(
      true,
    );
  });

  it('does not invent columns in a single-column page', () => {
    const lines = [
      line('A normal line of text that fills most of the measure here.', 72, 700, 450),
      line('Another normal line that also fills most of the measure.', 72, 686, 440),
      line('And a third line to give the detector enough data points.', 72, 672, 445),
      line('Fourth line of ordinary single-column body text.', 72, 658, 430),
      line('Fifth line, still single column and unremarkable.', 72, 644, 420),
      line('Sixth line to finish the sample page of text.', 72, 630, 400),
    ];
    const layout = detectColumns(lines, 612, { bodySize: 10 });
    expect(layout.isMultiColumn).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* headers, footers, page numbers                                     */
/* ------------------------------------------------------------------ */

describe('running heads and page numbers', () => {
  const pageHeight = 792;

  it('recognizes page-number-only lines', () => {
    expect(isPageNumberLine('12')).toBe(true);
    expect(isPageNumberLine('Page 12 of 300')).toBe(true);
    expect(isPageNumberLine('- 7 -')).toBe(true);
    expect(isPageNumberLine('12 people arrived')).toBe(false);
    expect(isPageNumberLine('iv', { marginal: true })).toBe(true);
    expect(isPageNumberLine('iv')).toBe(false);
  });

  it('normalizes changing digits in running heads', () => {
    expect(lineSignature('Chapter 4 · The Sea')).toBe('chapter # · the sea');
  });

  it('removes repeated headers and page numbers', () => {
    const lines = [
      line('The Book of Reflow', 72, 770, 120, 9),
      line('Body text on the page.', 72, 700, 200, 10),
      line('42', 300, 30, 10),
    ];

    const result = stripMarginalLines(lines, pageHeight, new Set(['the book of reflow']));
    expect(result.map((l) => l.text)).toEqual(['Body text on the page.']);
  });

  it('keeps them when the option is off', () => {
    const lines = [
      line('The Book of Reflow', 72, 770, 120, 9),
      line('Body text on the page.', 72, 700, 200, 10),
      line('42', 300, 30, 10),
    ];
    const result = stripMarginalLines(lines, pageHeight, new Set(['the book of reflow']), {
      removeHeaderFooter: false,
    });
    expect(result).toHaveLength(3);
  });

  it('builds a repeated-signature index from many pages', () => {
    const index = createMarginalIndex();
    for (let p = 1; p <= 4; p += 1) {
      addPageMarginals(
        index,
        [
          line('A Running Head', 72, 770, 100, 9),
          line('Body text unique to this page.', 72, 700, 200, 10),
          line(`Page ${p}`, 300, 30, 9),
        ],
        pageHeight,
      );
    }
    const repeated = findRepeatedMarginals(index);
    expect(repeated.has('a running head')).toBe(true);
    expect(repeated.has('page #')).toBe(true);
  });

  it('keeps a large chapter title even when its text repeats', () => {
    const lines = [
      line('The Book of Reflow', 72, 760, 260, 24),
      line('Body text on this page.', 72, 650, 200, 10),
    ];

    const result = stripMarginalLines(lines, pageHeight, new Set(['the book of reflow']), {
      bodySize: 10,
    });
    expect(result.map((l) => l.text)).toEqual([
      'The Book of Reflow',
      'Body text on this page.',
    ]);
  });

  it('does not treat a single occurrence as repeated', () => {
    const index = createMarginalIndex();
    addPageMarginals(index, [line('One-off header', 72, 770, 100, 9)], pageHeight);
    addPageMarginals(index, [line('Different header', 72, 770, 100, 9)], pageHeight);
    const repeated = findRepeatedMarginals(index);
    expect(repeated.size).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* whole-page integration                                             */
/* ------------------------------------------------------------------ */

describe('reflowPage', () => {
  it('joins a hyphenated word across two pdf items/lines', () => {
    const result = reflowPage({
      items: [
        item('This is an exam-', 72, 700, 10, 90),
        item('ple of reflowed text that continues.', 72, 686, 10, 200),
      ],
      pageNumber: 9,
      pageWidth: 612,
      pageHeight: 792,
      options: { removeHeaderFooter: false },
    });

    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].text).toBe(
      'This is an example of reflowed text that continues.',
    );
    expect(result.quality.scanned).toBe(false);
    expect(result.lines).toHaveLength(2);
  });

  it('reports an image-only page as scanned', () => {
    const result = reflowPage({ items: [], pageWidth: 612, pageHeight: 792 });
    expect(result.quality.scanned).toBe(true);
    expect(result.blocks).toHaveLength(0);
    expect(result.quality.reasons[0]).toMatch(/No text layer/);
  });

  it('drops a running head from a full page', () => {
    const result = reflowPage({
      items: [
        item('The Book of Reflow', 72, 770, 9, 110),
        item('This is the actual body text on the page.', 72, 700, 10, 240),
        item('12', 300, 30, 10, 12),
      ],
      pageWidth: 612,
      pageHeight: 792,
      marginalSignatures: new Set(['the book of reflow']),
    });

    expect(result.blocks.map((b) => b.text)).toEqual([
      'This is the actual body text on the page.',
    ]);
  });

  it('exposes low quality for a nearly empty text layer', () => {
    const result = reflowPage({
      items: [item('Hi', 72, 700, 10, 12)],
      pageWidth: 612,
      pageHeight: 792,
    });
    expect(result.quality.lowQuality).toBe(true);
    expect(result.quality.reasons.length).toBeGreaterThan(0);
  });

  it('computes a character-weighted body size', () => {
    const size = bodyFontSize(
      [
        line('Short heading', 72, 740, 100, 22),
        line('Lots of body text in the normal font size that dominates.', 72, 700, 300, 10),
        line('More body text in the normal font size.', 72, 686, 240, 10),
      ],
      { pageHeight: 792 },
    );
    expect(size).toBe(10);
  });

  it('keeps continuation lines of an indented paragraph together', () => {
    const result = reflowLines({
      lines: [
        line('First paragraph line that reaches the margin and ends.', 72, 700, 400, 10),
        line('Second paragraph starts with an indent.', 90, 672, 300, 10),
        line('Its continuation is indented the same way.', 90, 658, 310, 10),
        line('And it finishes here.', 90, 644, 140, 10),
      ],
      pageWidth: 612,
      pageHeight: 792,
      options: { removeHeaderFooter: false },
    });

    expect(result.blocks.map((b) => b.type)).toEqual(['paragraph', 'paragraph']);
    expect(result.blocks[1].text).toBe(
      'Second paragraph starts with an indent. Its continuation is indented the same way. And it finishes here.',
    );
  });

  it('returns a stable block list for a page with a heading and paragraphs', () => {
    const result = reflowLines({
      lines: [
        line('Chapter One', 72, 740, 110, 20),
        line('The first paragraph starts here and continues to a second line.', 72, 700, 420, 10),
        line('It ends with a full stop.', 72, 686, 140, 10),
        line('A new indented paragraph begins on this line.', 84, 660, 330, 10),
        line('And this is its last line.', 72, 646, 170, 10),
      ],
      pageNumber: 1,
      pageWidth: 612,
      pageHeight: 792,
      options: { removeHeaderFooter: false },
    });

    expect(result.blocks.map((b) => b.type)).toEqual(['heading', 'paragraph', 'paragraph']);
    expect(result.blocks[0].text).toBe('Chapter One');
    expect(result.blocks[1].text).toBe(
      'The first paragraph starts here and continues to a second line. It ends with a full stop.',
    );
    expect(result.blocks[2].text).toBe(
      'A new indented paragraph begins on this line. And this is its last line.',
    );
  });
});

/* ------------------------------------------------------------------ */
/* inline images                                                      */
/* ------------------------------------------------------------------ */

describe('inline images', () => {
  it('keeps a figure between the paragraphs that surround it', () => {
    const result = reflowLines({
      lines: [
        line('Chapter with a Figure', 72, 740, 200, 18),
        line('The paragraph before the figure starts here and runs on.', 72, 700, 420, 10),
        line('It ends on this second line.', 72, 686, 160, 10),
        line('The paragraph after the figure continues the argument.', 72, 500, 400, 10),
        line('And it finishes here.', 72, 486, 120, 10),
      ],
      images: [{ id: 'p1-i0', x: 72, y: 560, width: 300, height: 120 }],
      pageNumber: 1,
      pageWidth: 612,
      pageHeight: 792,
      options: { removeHeaderFooter: false },
    });

    expect(result.blocks.map((b) => b.type)).toEqual([
      'heading',
      'paragraph',
      'image',
      'paragraph',
    ]);
    expect(result.blocks[2].imageId).toBe('p1-i0');
    expect(result.blocks[2].image).toMatchObject({ x: 72, y: 560, width: 300, height: 120 });
    expect(result.blocks[2].text).toBe('');
    expect(result.blocks[1].text).not.toContain('after');
    expect(result.blocks[3].text).toMatch(/^The paragraph after/);
    expect(result.stats.imageCount).toBe(1);
  });

  it('orders an image before text that sits below it on the page', () => {
    const result = reflowLines({
      lines: [line('Text below the figure.', 72, 400, 180, 10)],
      images: [{ id: 'p1-i0', x: 72, y: 560, width: 300, height: 120 }],
      pageWidth: 612,
      pageHeight: 792,
      options: { removeHeaderFooter: false },
    });

    expect(result.blocks.map((b) => b.type)).toEqual(['image', 'paragraph']);
    expect(result.blocks[1].text).toBe('Text below the figure.');
  });

  it('returns image blocks for a page with no text layer', () => {
    const result = reflowLines({
      lines: [],
      images: [{ id: 'p1-i0', x: 16, y: 16, width: 580, height: 760 }],
      pageWidth: 612,
      pageHeight: 792,
    });

    expect(result.quality.scanned).toBe(true);
    expect(result.blocks.map((b) => b.type)).toEqual(['image']);
    expect(result.blocks[0].imageId).toBe('p1-i0');
    expect(result.stats.lineCount).toBe(0);
    expect(result.stats.imageCount).toBe(1);
  });

  it('ignores malformed image rectangles', () => {
    const result = reflowLines({
      lines: [line('Only text on this page.', 72, 700, 200, 10)],
      images: [
        { id: 'bad-1', x: 72, y: 560, width: 0, height: 120 },
        { id: 'bad-2', x: 72, y: NaN, width: 300, height: 120 },
      ],
      pageWidth: 612,
      pageHeight: 792,
      options: { removeHeaderFooter: false },
    });

    expect(result.blocks.map((b) => b.type)).toEqual(['paragraph']);
    expect(result.stats.imageCount).toBe(0);
  });
});

describe('bold headings', () => {
  it('propagates bold from items to lines', () => {
    const lines = groupLines([
      item('Bold', 72, 700, 10, 22, { bold: true }),
      item('plain text here', 98, 700, 10, 70),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0].bold).toBe(false);

    const boldOnly = groupLines([item('Bold title', 72, 700, 10, 50, { bold: true })]);
    expect(boldOnly[0].bold).toBe(true);
  });

  it('detects a bold section title just above body size', () => {
    const blocks = buildBlocks(
      [
        line('Standardized GenAI Stacks as an Internal Platform', 36, 700, 330, 12, {
          bold: true,
        }),
        line('Body text follows the section heading here.', 36, 670, 350, 10),
      ],
      { bodySize: 10, pageWidth: 612 },
    );

    expect(blocks[0].type).toBe('heading');
    expect(blocks[0].level).toBe(3);
    expect(blocks[0].text).toBe('Standardized GenAI Stacks as an Internal Platform');
  });

  it('leaves bold sentences and run-in labels as paragraphs', () => {
    const blocks = buildBlocks(
      [
        line('This whole line is bold but it is a sentence.', 36, 700, 300, 10, {
          bold: true,
        }),
        line('Note:', 36, 686, 40, 10, { bold: true }),
      ],
      { bodySize: 10, pageWidth: 612 },
    );

    expect(blocks.every((block) => block.type === 'paragraph')).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* table of contents                                                  */
/* ------------------------------------------------------------------ */

describe('table of contents', () => {
  function entry(title, page, x, y) {
    return [line(title, x, y, title.length * 5, 10), line(page, 564, y, 12, 10)];
  }

  it('pairs titles with right-aligned page numbers', () => {
    const blocks = buildBlocks(
      [
        line('TABLE OF CONTENTS', 36, 700, 150, 14),
        ...entry('INTRODUCTION', '20', 54, 660),
        ...entry('Exam Details', '23', 72, 643),
        ...entry('Content Domain 1: Foundation Model Integration', '24', 90, 626),
        line('Body text after the contents.', 36, 580, 250, 10),
      ],
      { bodySize: 10, pageWidth: 612 },
    );

    const toc = blocks.find((block) => block.type === 'toc');
    expect(toc).toBeTruthy();
    expect(toc.items.map((item) => item.title)).toEqual([
      'INTRODUCTION',
      'Exam Details',
      'Content Domain 1: Foundation Model Integration',
    ]);
    expect(toc.items.map((item) => item.page)).toEqual(['20', '23', '24']);
    expect(toc.items.map((item) => item.level)).toEqual([0, 1, 2]);
  });

  it('reads dot leaders', () => {
    const blocks = buildBlocks(
      [
        line('Chapter One ......... 1', 36, 660, 200, 10),
        line('Chapter Two ......... 5', 36, 643, 200, 10),
        line('Chapter Three ....... 9', 36, 626, 200, 10),
      ],
      { bodySize: 10, pageWidth: 612 },
    );

    expect(blocks[0].type).toBe('toc');
    expect(blocks[0].items.map((item) => item.title)).toEqual([
      'Chapter One',
      'Chapter Two',
      'Chapter Three',
    ]);
    expect(blocks[0].items.map((item) => item.page)).toEqual(['1', '5', '9']);
  });

  it('needs at least three entries', () => {
    const blocks = buildBlocks(
      [
        ...entry('One', '1', 54, 660),
        ...entry('Two', '2', 54, 643),
      ],
      { bodySize: 10, pageWidth: 612 },
    );

    expect(blocks.some((block) => block.type === 'toc')).toBe(false);
  });

  it('leaves body text that ends with a number alone', () => {
    const blocks = buildBlocks(
      [
        line('The answer is 42', 36, 660, 200, 10),
        line('And the next paragraph line.', 36, 645, 200, 10),
      ],
      { bodySize: 10, pageWidth: 612 },
    );

    expect(blocks.every((block) => block.type === 'paragraph')).toBe(true);
  });
});

describe('table of contents page numbers', () => {
  it('keeps a contents page number beside its title', () => {
    const lines = [
      line('INTRODUCTION', 54, 633, 84, 11),
      line('20', 564, 633, 12, 11),
      line('Body copy on the page.', 36, 400, 250, 11),
    ];
    const kept = stripMarginalLines(lines, 792, new Set(), { bodySize: 11 });
    expect(kept.map((l) => l.text)).toEqual(['INTRODUCTION', '20', 'Body copy on the page.']);
  });

  it('still drops a running page number in the bottom margin', () => {
    const lines = [
      line('https://portal.example.com/', 36, 51, 190, 10),
      line('1', 507, 51, 7, 10),
      line('Body copy on the page.', 36, 400, 250, 11),
    ];
    const kept = stripMarginalLines(lines, 792, new Set(['https://portal.example.com/']), {
      bodySize: 11,
    });
    expect(kept.map((l) => l.text)).toEqual(['Body copy on the page.']);
  });
});

/* ------------------------------------------------------------------ */
/* lists                                                              */
/* ------------------------------------------------------------------ */

describe('detectListMarker', () => {
  it('recognizes bullets', () => {
    expect(detectListMarker('● First item')).toEqual({
      ordered: false,
      marker: '●',
      number: null,
      text: 'First item',
    });
    expect(detectListMarker('○ Nested item').ordered).toBe(false);
    expect(detectListMarker('• Third style').text).toBe('Third style');
    // Filled squares open the deepest level in the study guide.
    expect(detectListMarker('■ Responses')).toEqual({
      ordered: false,
      marker: '■',
      number: null,
      text: 'Responses',
    });
    expect(detectListMarker('▪ Square bullet').ordered).toBe(false);
  });

  it('recognizes ordered markers', () => {
    expect(detectListMarker('1. First step')).toMatchObject({
      ordered: true,
      number: 1,
      text: 'First step',
    });
    expect(detectListMarker('(2) Second step')).toMatchObject({
      ordered: true,
      number: 2,
      text: 'Second step',
    });
    expect(detectListMarker('a) Alpha step')).toMatchObject({
      ordered: true,
      number: null,
      text: 'Alpha step',
    });
  });

  it('leaves normal text alone', () => {
    expect(detectListMarker('A. Smith wrote this')).toBeNull();
    expect(detectListMarker('e.g. this is prose')).toBeNull();
    expect(detectListMarker('Chapter 1.2.3 - Design')).toBeNull();
    expect(detectListMarker('●')).toBeNull();
    expect(detectListMarker('')).toBeNull();
  });
});

describe('list blocks', () => {
  it('groups nested bullets into one list with levels', () => {
    const blocks = buildBlocks(
      [
        line('Intro text before the list.', 36, 700, 300, 10),
        line('● First item', 54, 660, 200, 10),
        line('○ Sub item', 90, 645, 200, 10),
        line('○ Another sub item', 90, 630, 200, 10),
        line('● Second item', 54, 615, 200, 10),
        line('Text after the list.', 36, 580, 300, 10),
      ],
      { bodySize: 10, pageWidth: 612, pageNumber: 1 },
    );

    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'list', 'paragraph']);
    expect(blocks[1].items.map((i) => i.level)).toEqual([0, 1, 1, 0]);
    expect(blocks[1].items.map((i) => i.text)).toEqual([
      'First item',
      'Sub item',
      'Another sub item',
      'Second item',
    ]);
  });

  it('keeps a square-bullet sub-list under its parent item', () => {
    const blocks = buildBlocks(
      [
        line('3. In a notebook:', 54, 603, 69, 10),
        line('○ Loop over the questions.', 90, 588, 120, 10),
        line('○ Log:', 90, 558, 21, 10),
        line('■ Responses', 126, 543, 54, 10),
        line('■ Latency', 126, 528, 38, 10),
        line('■ Token counts', 126, 513, 66, 10),
        line('4. Have your team rate responses.', 54, 498, 300, 10),
      ],
      { bodySize: 10, pageWidth: 612, pageNumber: 1 },
    );

    const list = blocks.find((block) => block.type === 'list');
    expect(list.items.map((item) => item.text)).toEqual([
      'In a notebook:',
      'Loop over the questions.',
      'Log:',
      'Responses',
      'Latency',
      'Token counts',
      'Have your team rate responses.',
    ]);
    expect(list.items.map((item) => item.level)).toEqual([0, 1, 1, 2, 2, 2, 0]);
  });

  it('joins wrapped lines into the item they belong to', () => {
    const blocks = buildBlocks(
      [
        line('● A long bullet that wraps', 54, 660, 300, 10),
        line('onto a second line.', 70, 645, 200, 10),
        line('and a third line.', 70, 630, 200, 10),
        line('● Next item', 54, 615, 200, 10),
      ],
      { bodySize: 10, pageWidth: 612, pageNumber: 1 },
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('list');
    expect(blocks[0].items).toHaveLength(2);
    expect(blocks[0].items[0].text).toBe(
      'A long bullet that wraps onto a second line. and a third line.',
    );
  });

  it('does not swallow an indented paragraph after a list', () => {
    const blocks = buildBlocks(
      [
        line('● Only item', 54, 660, 200, 10),
        line('Indented paragraph line', 47, 645, 300, 10),
      ],
      { bodySize: 10, pageWidth: 612, pageNumber: 1 },
    );

    expect(blocks.map((b) => b.type)).toEqual(['list', 'paragraph']);
  });

  it('keeps ordered numbers', () => {
    const blocks = buildBlocks(
      [
        line('1. First step', 36, 700, 200, 10),
        line('2. Second step', 36, 685, 200, 10),
      ],
      { bodySize: 10, pageWidth: 612, pageNumber: 1 },
    );

    expect(blocks[0].type).toBe('list');
    expect(blocks[0].items.map((i) => i.number)).toEqual([1, 2]);
    expect(blocks[0].items.every((i) => i.ordered)).toBe(true);
  });

  it('keeps lists intact through reflowLines', () => {
    const result = reflowLines({
      lines: [
        line('● First item', 54, 660, 200, 10),
        line('○ Sub item', 90, 645, 200, 10),
      ],
      pageWidth: 612,
      pageHeight: 792,
    });

    const list = result.blocks.find((b) => b.type === 'list');
    expect(list).toBeTruthy();
    expect(list.items).toHaveLength(2);
    expect(result.stats.blockCount).toBe(result.blocks.length);
  });
});

/* ------------------------------------------------------------------ */
/* tables                                                             */
/* ------------------------------------------------------------------ */

describe('table blocks', () => {
  const table = {
    x: 36,
    y: 500,
    width: 320,
    height: 60,
    columns: 2,
    header: false,
    rows: [
      [
        { text: 'AWS Lambda', bold: true },
        { text: 'Validation logic', bold: false },
      ],
      [
        { text: 'Amazon Bedrock', bold: true },
        { text: 'Constrained outputs', bold: false },
      ],
    ],
  };

  it('replaces the table lines with one table block', () => {
    const result = reflowLines({
      lines: [
        line('Text before the table.', 36, 620, 250, 11),
        line('AWS Lambda', 41, 545, 66, 11),
        line('Validation logic', 226, 545, 75, 11),
        line('Amazon Bedrock', 41, 515, 84, 11),
        line('Constrained outputs', 226, 515, 99, 11),
        line('Text after the table.', 36, 440, 250, 11),
      ],
      tables: [table],
      pageWidth: 612,
      pageHeight: 792,
    });

    expect(result.blocks.map((block) => block.type)).toEqual([
      'paragraph',
      'table',
      'paragraph',
    ]);
    expect(result.blocks[1].rows).toEqual(table.rows);
    expect(result.blocks[1].columns).toBe(2);
    expect(result.stats.tableCount).toBe(1);
  });

  it('keeps a table on a page with no other text', () => {
    const result = reflowLines({
      lines: [line('AWS Lambda', 41, 545, 66, 11)],
      tables: [table],
      pageWidth: 612,
      pageHeight: 792,
    });

    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].type).toBe('table');
    expect(result.quality.scanned).toBe(false);
  });

  it('does not let table cells create page columns', () => {
    const result = reflowLines({
      lines: [
        line('A normal paragraph before the table.', 36, 650, 320, 11),
        line('AWS Lambda', 41, 545, 66, 11),
        line('Validation logic', 226, 545, 75, 11),
      ],
      tables: [table],
      pageWidth: 612,
      pageHeight: 792,
    });

    expect(result.layout.isMultiColumn).toBe(false);
    expect(result.blocks.some((block) => block.type === 'table')).toBe(true);
  });
});
