// Generates public/sample.pdf with a tiny hand-written PDF writer.
// Four pages: prose, a two-column spread, a typography page, and one
// image-only (scanned) page with no text objects.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'public');
mkdirSync(outDir, { recursive: true });

const PAGE_W = 612;
const PAGE_H = 792;

function esc(text) {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function text(font, x, y, size, content, color = null) {
  const fill = color ? `${color} rg ` : '';
  return `BT ${fill}/F${font} ${size} Tf 1 0 0 1 ${x} ${y} Tm (${esc(content)}) Tj ET\n`;
}

function header(content) {
  return text(1, 72, 758, 8, content, '0.45 0.42 0.36');
}

function footer(n) {
  return text(1, 300, 38, 9, String(n), '0.4 0.38 0.33');
}

/* --------------------------- raster figure -------------------------- */

// A small RGB illustration used to demonstrate inline images. Pixels are
// generated directly so the sample needs no binary assets or build tools.
function figurePixels(width, height) {
  const px = Buffer.alloc(width * height * 3);
  const set = (x, y, [r, g, b]) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 3;
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
  };

  const paper = [247, 243, 234];
  const ink = [58, 47, 39];
  const accent = [178, 92, 60];
  const muted = [206, 190, 168];

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) set(x, y, paper);
  }

  // Frame.
  for (let x = 8; x < width - 8; x += 1) {
    set(x, 8, muted);
    set(x, height - 9, muted);
  }
  for (let y = 8; y < height - 8; y += 1) {
    set(8, y, muted);
    set(width - 9, y, muted);
  }

  // Sun.
  const cx = width * 0.5;
  const cy = height * 0.4;
  const radius = height * 0.2;
  for (let y = Math.floor(cy - radius); y <= cy + radius; y += 1) {
    for (let x = Math.floor(cx - radius); x <= cx + radius; x += 1) {
      const dx = (x - cx) / radius;
      const dy = (y - cy) / radius;
      if (dx * dx + dy * dy <= 1) set(x, y, accent);
    }
  }

  // Three books resting at the bottom.
  const books = [
    { x: 64, y: height - 66, w: 192, h: 16, color: ink },
    { x: 78, y: height - 48, w: 168, h: 13, color: [110, 88, 70] },
    { x: 92, y: height - 32, w: 140, h: 10, color: [140, 112, 88] },
  ];
  for (const book of books) {
    for (let y = book.y; y < book.y + book.h; y += 1) {
      for (let x = book.x; x < book.x + book.w; x += 1) set(x, y, book.color);
    }
    // A lighter spine band.
    for (let y = book.y + 2; y < book.y + book.h - 2; y += 1) {
      for (let x = book.x + 8; x < book.x + 12; x += 1) set(x, y, paper);
    }
  }

  return px;
}

const FIGURE_W = 320;
const FIGURE_H = 200;
const FIGURE_DATA = deflateSync(figurePixels(FIGURE_W, FIGURE_H)).toString('hex');

/* ------------------------------ page 1 ------------------------------ */

const page1 = [
  header('THE QUIET ART OF READING'),
  text(2, 72, 714, 26, 'The Quiet Art of Reading'),
  text(3, 72, 690, 12, 'A sample document for the Reflow Reader'),
  '0.55 0.18 0.10 rg 72 672 m 240 672 l S\n',
  text(1, 72, 646, 12, 'The Reflow Reader takes the fixed geometry of a PDF and turns it'),
  text(1, 72, 630, 12, 'into a stream of text that can be read like an EPUB. Instead of'),
  text(1, 72, 614, 12, 'pinching and zooming around a fixed page, you can change the type'),
  text(1, 72, 598, 12, 'size, line length and theme, and let the words settle into a shape'),
  text(1, 72, 582, 12, 'that suits the screen in front of you.'),
  text(1, 90, 552, 12, 'Extraction is only half the work. Reading order, paragraph'),
  text(1, 90, 536, 12, 'detection and running-head removal are all heuristics, and the best'),
  text(1, 90, 520, 12, 'result comes from combining several weak signals rather than trusting'),
  text(1, 90, 504, 12, 'any single measurement. This paragraph is indented to demonstrate'),
  text(1, 90, 488, 12, 'how the reader finds a new paragraph without a large vertical gap.'),
  text(1, 72, 458, 12, 'This sentence contains an exam-'),
  text(1, 72, 442, 12, 'ple of a word split across two lines, which the reflow engine'),
  text(1, 72, 426, 12, 'repairs before it reaches your eyes.'),
  text(1, 72, 396, 12, 'No document ever leaves this browser tab. The file is read with the'),
  text(1, 72, 380, 12, 'File API, parsed by pdf.js inside the page, and cached only in local'),
  text(1, 72, 364, 12, 'storage. There is no account, no upload and no analytics.'),
  footer(1),
].join('');

/* ------------------------------ page 2 ------------------------------ */

// Approximate Helvetica wrapping is enough here: each column is capped at 42
// characters so the two text blocks stay well clear of the gutter.
function wrappedLines(content, maxChars) {
  const lines = [];
  let line = '';
  for (const word of content.split(/\s+/)) {
    if (!line) line = word;
    else if (line.length + 1 + word.length <= maxChars) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function column(x, y, paragraphs, { size = 10, leading = 14, maxChars = 42 } = {}) {
  const parts = [];
  for (const [index, paragraph] of paragraphs.entries()) {
    if (index > 0) y -= leading * 0.5;
    for (const line of wrappedLines(paragraph, maxChars)) {
      parts.push(text(1, x, y, size, line));
      y -= leading;
    }
  }
  return { content: parts.join(''), y };
}

const leftColumn = column(72, 698, [
  'Magazines, journals and academic papers often set their body text in two or more columns. A naive extractor reads straight across the page, producing sentences that jump between unrelated paragraphs. The reader instead looks for a vertical gutter, groups the lines on either side, and reads the left column from top to bottom before moving to the right column.',
  'Wide headings split a page into horizontal bands. Within each band the columns are read in order. This is enough for most newspapers, journals and reports. Complex grids, tables and sidebars remain outside the model.',
  'A second paragraph in the left column illustrates the indentation cue. The reader also notices the change in line length and the end of a sentence. No single signal decides where a paragraph ends.',
]);

const rightColumn = column(330, 698, [
  'The right column begins here. In the original PDF it sits beside the left column, but in the reading view it simply follows it. The small page label above each section lets you compare the two representations when something looks wrong.',
  'Headers and footers are detected by sampling pages across the document. A line that recurs in the same margin on enough pages is dropped from the reading view. Page numbers are removed on sight. Both behaviours can be switched off.',
  'The sample on this page deliberately repeats its running head and page number so that you can toggle the option in Settings and watch them disappear or return. This line is short.',
]);

const page2 = [
  header('THE QUIET ART OF READING'),
  text(2, 72, 728, 19, 'Two Columns, One Reading Order'),
  leftColumn.content,
  rightColumn.content,
  text(2, 72, 380, 12, 'Typography is a set of choices for every reader and screen'),
  text(1, 72, 356, 10, 'Serif, sans or a dyslexia-friendly face; a tighter or looser line height; a narrow measure'),
  text(1, 72, 342, 10, 'or a generous one. All of it can be changed while keeping your place in the document.'),
  'q 240 0 0 150 186 160 cm /Im1 Do Q\n',
  text(1, 186, 142, 9, 'Figure 1. A raster image is kept in the reading order of the page.'),
  footer(2),
].join('');

/* ------------------------------ page 3 ------------------------------ */

const page3 = [
  header('THE QUIET ART OF READING'),
  text(2, 72, 728, 19, 'What the Reader Can Do'),
  text(1, 72, 698, 12, 'Open a PDF with the file picker or drag it onto the window. The title, page'),
  text(1, 72, 682, 12, 'count and reading position are remembered for that document, keyed by a hash'),
  text(1, 72, 666, 12, 'of its contents. Reopening the same file returns you to the same place.'),
  text(2, 72, 632, 15, 'Reading controls'),
  text(1, 72, 608, 12, 'Use the arrow keys, Page Up and Page Down, Space, Home and End. On a phone, swipe'),
  text(1, 72, 592, 12, 'sideways in paginated mode. The progress bar and the page box at the bottom can'),
  text(1, 72, 576, 12, 'take you anywhere in the document. The contents drawer is built from the PDF'),
  text(1, 72, 560, 12, 'outline when one exists.'),
  text(1, 72, 530, 12, 'Text remains selectable, so the browser\u2019s own Find command works. The in-book'),
  text(1, 72, 514, 12, 'search scans every page in the background and highlights matches on the page.'),
  text(2, 72, 480, 15, 'A note on quality'),
  text(1, 72, 456, 12, 'Reflow is a heuristic. Scanned pages have no text layer and are shown as images'),
  text(1, 72, 440, 12, 'with an explanation. Pages with very little text fall back to the original view.'),
  text(1, 72, 424, 12, 'Pages where the column model is uncertain keep their reflow but show a warning'),
  text(1, 72, 408, 12, 'and a one-click switch. You can always compare against the page itself.'),
  text(1, 72, 362, 8, '1. This footnote is set in a smaller size and is styled as small print rather than body copy.'),
  text(1, 72, 350, 8, '2. It is still selectable and searchable, like every other piece of extracted text.'),
  footer(3),
].join('');

/* ------------------------------ page 4 ------------------------------ */
// No text operators at all: this simulates a scanned page. pdf.js will report
// zero text items and the reader will render the page as an image.

const page4 = [
  '0.93 0.90 0.83 rg 0 0 612 792 re f\n',
  '0.98 0.96 0.91 rg 66 66 480 660 re f\n',
  '0.82 0.78 0.69 rg 96 92 420 608 re f\n',
  '0.30 0.28 0.24 rg 120 620 220 34 re f\n',
  '0.30 0.28 0.24 rg 120 570 360 12 re f\n',
  '0.45 0.42 0.36 rg 120 548 330 8 re f\n',
  '0.45 0.42 0.36 rg 120 534 350 8 re f\n',
  '0.45 0.42 0.36 rg 120 520 300 8 re f\n',
  '0.55 0.50 0.42 rg 120 470 390 2 re f\n',
  '0.45 0.42 0.36 rg 120 448 350 8 re f\n',
  '0.45 0.42 0.36 rg 120 434 365 8 re f\n',
  '0.45 0.42 0.36 rg 120 420 280 8 re f\n',
  '0.45 0.42 0.36 rg 120 406 340 8 re f\n',
  '0.45 0.42 0.36 rg 120 392 390 8 re f\n',
  '0.55 0.50 0.42 rg 120 370 390 2 re f\n',
  '0.45 0.42 0.36 rg 120 348 355 8 re f\n',
  '0.45 0.42 0.36 rg 120 334 370 8 re f\n',
  '0.45 0.42 0.36 rg 120 320 260 8 re f\n',
  '0.45 0.42 0.36 rg 120 306 345 8 re f\n',
  '0.55 0.50 0.42 rg 120 280 390 2 re f\n',
  '0.45 0.42 0.36 rg 120 258 360 8 re f\n',
  '0.45 0.42 0.36 rg 120 244 325 8 re f\n',
  '0.45 0.42 0.36 rg 120 230 350 8 re f\n',
  '0.45 0.42 0.36 rg 120 216 300 8 re f\n',
  '0.22 0.20 0.18 rg 120 130 150 70 re f\n',
  '0.98 0.96 0.91 rg 130 140 3 50 re f\n',
  '0.98 0.96 0.91 rg 138 140 2 50 re f\n',
  '0.98 0.96 0.91 rg 146 140 4 50 re f\n',
  '0.98 0.96 0.91 rg 157 140 2 50 re f\n',
  '0.98 0.96 0.91 rg 165 140 3 50 re f\n',
  '0.98 0.96 0.91 rg 175 140 2 50 re f\n',
  '0.98 0.96 0.91 rg 184 140 4 50 re f\n',
  '0.98 0.96 0.91 rg 195 140 2 50 re f\n',
  '0.98 0.96 0.91 rg 203 140 3 50 re f\n',
  '0.45 0.42 0.36 rg 300 170 200 8 re f\n',
  '0.45 0.42 0.36 rg 300 154 170 6 re f\n',
].join('');

/* --------------------------- PDF assembly --------------------------- */

const pageObjects = [7, 8, 9, 10];
const contentObjects = [11, 12, 13, 14];
const contents = [page1, page2, page3, page4];

const objects = new Map();
objects.set(1, '<< /Type /Catalog /Pages 2 0 R /Outlines 15 0 R /PageMode /UseOutlines >>');
objects.set(
  2,
  `<< /Type /Pages /Kids [${pageObjects.map((n) => `${n} 0 R`).join(' ')}] /Count 4 >>`,
);
objects.set(
  3,
  '<< /Title (The Quiet Art of Reading) /Author (Reflow Reader) /Subject (A sample for the Reflow Reader) /Creator (pdfreader sample generator) /Producer (pdfreader) >>',
);
objects.set(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
objects.set(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
objects.set(6, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>');

for (let i = 0; i < 4; i += 1) {
  const contentObject = contentObjects[i];
  objects.set(
    pageObjects[i],
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 4 0 R /F2 5 0 R /F3 6 0 R >>${
      i === 1 ? ' /XObject << /Im1 19 0 R >>' : ''
    } >> /Contents ${contentObject} 0 R >>`,
  );
  objects.set(
    contentObject,
    `<< /Length ${Buffer.byteLength(contents[i], 'latin1')} >>\nstream\n${contents[i]}\nendstream`,
  );
}

objects.set(15, '<< /Type /Outlines /First 16 0 R /Last 18 0 R /Count 3 >>');
objects.set(
  16,
  '<< /Title (Chapter One: A Stream of Text) /Parent 15 0 R /Dest [7 0 R /XYZ 0 792 null] /Next 17 0 R >>',
);
objects.set(
  17,
  '<< /Title (Chapter Two: Two Columns) /Parent 15 0 R /Dest [8 0 R /XYZ 0 792 null] /Prev 16 0 R /Next 18 0 R >>',
);
objects.set(
  18,
  '<< /Title (Chapter Three: What the Reader Can Do) /Parent 15 0 R /Dest [9 0 R /XYZ 0 792 null] /Prev 17 0 R >>',
);
objects.set(
  19,
  `<< /Type /XObject /Subtype /Image /Width ${FIGURE_W} /Height ${FIGURE_H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter [/ASCIIHexDecode /FlateDecode] /Length ${FIGURE_DATA.length + 1} >>\nstream\n${FIGURE_DATA}>\nendstream`,
);

let pdf = '%PDF-1.5\n%\xE2\xE3\xCF\xD3\n';
const offsets = new Map();

for (let i = 1; i <= 19; i += 1) {
  offsets.set(i, Buffer.byteLength(pdf, 'latin1'));
  pdf += `${i} 0 obj\n${objects.get(i)}\nendobj\n`;
}

const xrefOffset = Buffer.byteLength(pdf, 'latin1');
let xref = `xref\n0 20\n0000000000 65535 f \n`;
for (let i = 1; i <= 19; i += 1) {
  xref += `${String(offsets.get(i)).padStart(10, '0')} 00000 n \n`;
}
pdf += xref;
pdf += `trailer\n<< /Size 20 /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

writeFileSync(resolve(outDir, 'sample.pdf'), Buffer.from(pdf, 'latin1'));
console.log(`[pdfreader] wrote public/sample.pdf (${Buffer.byteLength(pdf, 'latin1')} bytes)`);
