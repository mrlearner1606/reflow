# Reflow — a PDF reader for reading

**[Open Reflow](https://mrlearner1606.github.io/reflow/)** — no install, no
account, files stay in the browser.

A browser-only PDF reader that turns fixed page geometry into a stream of text
you can read like an EPUB. Open a PDF, choose a comfortable type size, line
length and theme, and read without pinching or zooming. Inline figures stay in
the text where they belong.

Everything runs in the tab. The file is read with the File API, parsed by
pdf.js locally, and never uploaded. There is no backend, no account, no
analytics and no runtime CDN request.

## Quick start

Requires Node.js 18 or newer.

```bash
npm install       # also copies the pdf.js worker, cmaps and fonts to public/
npm run dev       # http://localhost:5173
```

Production build and preview:

```bash
npm run build
npm run preview   # http://localhost:4173
```

Unit tests for the reflow engine:

```bash
npm test          # one run
npm run test:watch
```

Regenerate the bundled sample document:

```bash
npm run sample    # writes public/sample.pdf
```

Publish the static site to GitHub Pages (builds, then force-pushes `dist/` to
the `gh-pages` branch):

```bash
npm run deploy    # https://mrlearner1606.github.io/reflow/
```

Open `http://localhost:5173`, click **Open sample**, or drop any PDF onto the
window. The sample has four pages: prose, a two-column page with an inline
figure, a typography page, and an image-only page that demonstrates the scanned
fallback.

A local copy of the *AWS Generative AI Developer Professional* study guide used
to check table reflow can be kept in `public/test/` (git-ignored, not part of
the published site). Open it with **Choose a PDF** and go to page 277 for the
two-approach comparison table.

## Using the reader

- **Open a file** with the button in the top bar or by dropping it on the
  window. Password-protected PDFs prompt for the password and retry cleanly.
- **Scroll mode** is a continuous reading stream. **Paginated mode** lays the
  current page out in screen-sized CSS columns and steps sideways, then moves
  to the next PDF page.
- **Typography**: serif, sans or OpenDyslexic; size, line height, paragraph
  spacing, measure (text width), justification, and light, sepia, dark or
  high-contrast themes. Settings apply immediately and are remembered.
- **Contents** is built from the PDF outline. **Search** scans every page in
  the background and highlights matches; browser Find also works because the
  text is real, selectable text.
- **Original page** shows the PDF page as rendered by pdf.js, with zoom and
  page stepping, so you can compare against the source.
- **Progress** is saved per document: page, offset within the page, and that
  document's settings. Reopening the same file returns to the same place.
- The page box and the progress bar jump anywhere in the document.

Keyboard: `→`, `Page Down` and `Space` move forward; `←` and `Page Up` move
back; `Home` and `End` go to the start and end. In paginated mode the arrow
keys and a horizontal swipe step between screens. `Escape` closes drawers and
dialogs.

## How reflow works

`src/reflow.js` is a pure module: it takes pdf.js text items with coordinates
and returns headings, paragraphs and image blocks. No DOM, no pdf.js import, so
every heuristic is unit-testable.

1. **Lines** — items sharing a baseline are grouped into lines. Wide horizontal
   gaps split same-baseline runs, so two columns are not glued together.
2. **Margins** — up to eight spread pages are sampled for recurring top/bottom
   lines. A signature that appears on at least 40 % of the sample (minimum two
   pages) is treated as a running head or footer. Page-number-only lines are
   removed independently. Large text is exempt, so a chapter title that happens
   to repeat is not mistaken for a header. The whole pass can be switched off.
3. **Columns** — a vertical projection of narrow body lines finds gutters.
   Coverage is counted per bin rather than marked present/absent, so a caption
   or pull quote crossing the gutter does not hide it. Full-width headings and
   paragraphs split the page into horizontal bands; each band is read column by
   column, left to right.
4. **Paragraphs** — a new paragraph starts on a large vertical gap, an indent
   step, a short previous line that ends a sentence, a font-size change, or a
   change of column or band. Continuation lines of an indented paragraph stay
   together. Line-end hyphenation is repaired when the next line starts
   lowercase; a hyphen before an uppercase letter or digit is kept.
5. **Headings** — body size is a character-weighted median. `>= 1.55×` becomes
   an `<h2>`, `>= 1.18×` (and short) an `<h3>`. A short, bold line without
   sentence punctuation becomes an `<h3>` even when it is only slightly larger
   than the body (12 pt against 11 pt, common in study guides). Bold sentences
   and run-in labels (`Note:`) stay paragraphs. Text below `0.84×` is styled as
   small print.
6. **Lists** — a leading bullet (`●`, `○`, `•`, `▪`, `■`, `◆`, `✓`, `-`, `–`) or
   ordered marker (`1.`, `2)`, `(3)`, `a)`) starts a list item. Items are grouped
   into nested `<ul>`/`<ol>` elements by their left edge, so sub-bullets keep
   their level — including the filled-square level under a hollow-circle item.
   Wrapped lines join the item they belong to, and a normal paragraph at the
   column edge closes the list.
7. **Contents pages** — a title line and a right-aligned number on the same
   baseline are paired as a contents entry, as are lines that already contain
   dot leaders. Three or more consecutive pairs become a TOC block, rendered as
   title / dotted leader / page number with indentation taken from the title's
   left edge. The number is kept even though a lone number would be treated as
   page furniture. Titles that wrap keep their leader and number on the last
   line, as in print.
8. **Tables** — ruled tables are read from the page's drawing operators:
   horizontal and vertical rules that intersect form a grid, and cell-sized
   rectangles contribute their edges when no drawn grid exists. Each text run
   is assigned to the cell that contains it, so neighbouring cells that touch
   no longer merge into one line. Inside a cell, the extra baseline gap left by
   a blank line starts a new paragraph, and bold runs are kept, so a cell with
   a paragraph followed by a bold `Metrics:` and `Best For:` keeps that shape
   instead of collapsing into one run-on string. Rows with no text are dropped,
   a fully bold first row becomes a `<thead>`, and the reader renders the result
   as a real `<table>`. Border-only boxes that are not tables (callouts, code listings)
   are rejected by grid occupancy, multi-cell rows and per-column usage.
9. **Quality** — pages with no text layer are marked scanned. Every page that
   produced text or images reflows; the reader never switches to the original
   view on its own. Only a page with nothing to reflow (no text and no
   extractable image) shows the page canvas. Uncertain layouts keep the reflow
   but show a warning and a one-click switch to the original.

The thresholds live in `DEFAULT_REFLOW_OPTIONS` at the top of `src/reflow.js`.

### Inline images

Raster images are kept in the reading stream, in page order, between the text
that surrounds them:

- `src/pdfLoader.js` walks the page operator list, tracks the graphics
  transform stack, and records the rectangle of every painted image. Tiny marks
  (under 20 pt per side) are ignored. Placements covering more than 78 % of the
  page are marked as page-sized: on a text page they are treated as
  backgrounds and skipped, while on an image-only page the page image itself is
  kept and shown in the reading flow.
- Header and footer images are excluded. `src/imagePlacement.js` drops a
  placement when more than half of its height falls in the top or bottom 12 %
  band, when it sits wholly inside the outer 15 % band (banners and oversized
  logos), or when it is small and hugs the top or bottom fifth of the page.
  The rules scale with the page, so they work for A4, Letter and other sizes.
- Page backgrounds are excluded on text pages. A raster that covers at least
  35 % of the page and has two or more text lines drawn on top of it (one line
  is enough above 45 %) is a scan with an invisible OCR layer, a screenshot of
  the content block or a watermark, not a figure; keeping it would repeat the
  page next to its own reflowed text. A smaller raster with three or more lines
  on top is the same kind of painted panel — the study guide's blue `Use Cases`
  boxes are only a quarter of a page — so it is dropped too, while a diagram or
  UI screenshot (whose text is part of the pixels) keeps its place.
- The page is composited once at up to 2× scale, and each rectangle is cropped
  from that canvas to WebP (PNG fallback). Cropping the rendered page preserves
  masks, soft masks and transparency. Crops are cached per page.
- `src/reflow.js` inserts each image as a zero-text line at its top edge, so the
  existing ordering puts it before the paragraph that follows it. It emits an
  `image` block that the reader renders as a `<figure>`.
- Images hydrate lazily, after the surrounding text is already on screen, and
  work in both scroll and paginated modes. A figure is never split across a
  paginated column break.

Limitations: vector drawings and charts made only of paths are not extracted as
images (they stay part of the text flow or are visible in the original page
view). Images tiled or painted repeatedly are treated as separate placements.
A caption is ordinary text, so it may be joined to a nearby paragraph if the
spacing suggests they belong together.

## Local-only storage

- **localStorage** keeps global settings and, per document, the title, page
  count, settings and reading position. The document key is a SHA-256 of the
  file (for files over 64 MB, of the size plus the first and last 2 MB), with a
  `name + size + lastModified` fallback.
- **IndexedDB** caches extracted page lines and geometry, keyed by document and
  a reflow version. Changing the layout code invalidates old entries.
- Nothing is written anywhere else. Clearing site data removes the cache and
  the remembered positions.

## Scanned pages and OCR

A page with no text layer is detected automatically. If it contains a raster
page image, that image is shown inline in the reading flow with a clear notice,
and the **Original page** toggle still opens the source page. Vector-only pages
with no text fall back to the original page canvas, because there is nothing
else to show.

Pages are never switched to the original view on their own: a page with text,
even a single heading, stays in the reflow and the original page is one click
away. The original view is only automatic when the page has no text and no
extractable image.

No OCR engine is bundled, because it would add several megabytes. `src/ocr.js`
exposes
`registerOcrEngine()`, `unregisterOcrEngine()` and `recognizePage()`; the
Settings panel has a disabled **Try OCR** switch. A local Tesseract.js worker
can be registered from `src/main.js` without changing the reader. Keep the
engine, its worker and language data inside the project so the app stays
offline.

## Known limitations

- Reflow is heuristic. Complex magazine grids, tables, sidebars, equations and
  interleaved captions can be ordered incorrectly. The original-page view is
  the source of truth.
- Rotated pages (`/Rotate 90`) use unrotated coordinates for reflow, so column
  detection may be odd. The original view is always correct.
- Running heads are sampled from up to eight pages. A header that first appears
  deep in a very long document can be missed.
- Header/footer image removal is geometric. A figure that sits entirely in the
  top or bottom margin, or a small logo just inside the text block, is treated
  as page furniture and dropped; a decorative image inside the text block is
  kept.
- Hyphen repair can join a genuine compound that breaks at its hyphen
  (`well-` / `known`). It deliberately avoids joining before uppercase letters
  and digits.
- Search matches raw lines while the reading view shows joined paragraphs, so
  hit counts can differ slightly around hyphenated breaks. Matches are capped at
  500.
- Very large PDFs are extracted lazily, page by page, and cached; the first
  visit to a distant page may show a brief placeholder.
- A page with no text and no extractable image (for example a vector-only
  scan) opens in the original view, because there is nothing to reflow.
- Reflow does not reconstruct tagged-PDF semantics, forms, annotations or
  bookmarks beyond the outline.

## Project structure

```
index.html                 app shell, drawers, dialogs, landing page
src/main.js                app lifecycle: open/drop, password flow, persistence
src/pdfLoader.js           pdf.js wrapper: text lines, page render, image rects/crops
src/reflow.js              pure line/column/paragraph/heading/image engine
src/imagePlacement.js      pure geometry: is an image a header/footer ornament?
src/reader.js              reader controller: lazy pages, scroll/paged, search, TOC
src/settings.js            defaults, validation, CSS variables, settings panel
src/storage.js             localStorage + IndexedDB persistence
src/ui.js                  DOM refs, drawers, toasts, dialogs
src/ocr.js                 optional OCR registration hook
src/styles.css             themes, reader, paginated columns, figures, responsive
tests/reflow.test.js       unit tests for the reflow engine
tests/imagePlacement.test.js  unit tests for header/footer image exclusion
scripts/copy-worker.mjs    copies worker/cmaps/fonts from pdfjs-dist to public/
scripts/generate-sample-pdf.mjs  builds public/sample.pdf (text, columns, figure, scan)
```

The pdf.js worker and its assets are copied into `public/` by
`scripts/copy-worker.mjs`, which runs on install, dev and build. Nothing is
loaded from a CDN at runtime.

See `NOTES.md` for the reference-project review and the reasoning behind the
layout heuristics.
