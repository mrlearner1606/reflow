# Project notes

## 1. What the reference project contains

`/home/krishna/Downloads/code/rea` is **REA: Reverse Engineer Anything**, an MCP
server / CLI for reverse engineering binaries, applications and runtime
behaviour. It is a large TypeScript monorepo (Node.js, npm workspaces, Turbo,
tsup, Vitest, oxlint/oxfmt) with adapters for Ghidra, Hopper, IDA, Frida, ADB,
browser runtimes, Electron, firmware, APKs and similar targets.

It contains **nothing related to PDF parsing, text reflow or ebook readers**. A
repo-wide search for "pdf" only matches dependency lockfile noise and a release
changelog. Nothing in REA is reusable for this task.

**Conclusion:** fresh, unrelated design. The only convention worth borrowing is
the general "plain ES modules + Vitest" style, which fits a small browser app.

## 2. Stack

- **Vite 5 + vanilla JavaScript (ES modules) + CSS.** No UI framework. The app
  is small enough that direct DOM code is simpler and faster to boot.
- **pdfjs-dist 4.10** for parsing, text extraction and canvas rendering.
- **Vitest** for unit tests. The reflow module has no DOM or pdf.js imports, so
  every layout heuristic is testable from plain coordinate data.
- The pdf.js worker (`pdf.worker.min.mjs`), its character maps and standard
  fonts are copied into `public/` from `node_modules` by
  `scripts/copy-worker.mjs` on install/dev/build. Nothing is fetched from a CDN.
- No backend. The selected file is read with `File.arrayBuffer()` and passed to
  pdf.js in the page. No network request is made with document contents.
- IndexedDB stores extracted page lines; localStorage stores settings, document
  metadata and reading positions. Both are origin-local.

## 3. Decisions where the spec left room

- **Page key:** SHA-256 of the file bytes (for files over 64 MB, SHA-256 of the
  size plus the first and last 2 MB, to avoid a long hash pause). The key falls
  back to `name + size + lastModified` if WebCrypto is unavailable.
- **What is cached:** normalized lines (text + geometry) go to IndexedDB; the
  reflowed block list is rebuilt from them in memory. This makes paging fast
  without duplicating both representations, and lets "remove headers/footers"
  be toggled without re-parsing the PDF. A cache version invalidates old data;
  bump `REFLOW_VERSION` in `src/reflow.js` whenever line extraction or block
  semantics change, otherwise existing readers keep serving pages extracted by
  the old rules (for example a contents page whose title and number had been
  merged into one line).
- **Header/footer detection** is based on a sample of up to 8 pages spread
  through the document (first, last and evenly spaced). A line in the top or
  bottom 12 % of a page is a running-head candidate. Its normalized signature
  (lowercase, digits replaced with `#`) must occur on at least 40 % of the
  sampled pages (minimum 2). Page-number-only lines are removed independently.
  Sampling up front makes page 1 and the current page agree with each other.
  Headers that first appear on page 100 can therefore be missed; documented.
- **Hyphenation:** a line ending in a letter + `-` is joined to the next line
  without a space when the next line starts with a lowercase letter. This is the
  requested rule. It can misjoin a real compound that happens to break at its
  hyphen (`well-` / `known` becomes `wellknown`). A longer dictionary-based
  check would be a future improvement; the false negative (leaving a hyphen)
  is less harmful than over-joining, so the rule is intentionally conservative
  about **not** removing hyphens before uppercase/digit starts.
- **Column detection:** projection over the body-line x-extents with wide
  headings excluded. Bins are counted rather than marked present/absent, so a
  caption or pull quote crossing the gutter leaves a low-coverage band instead
  of hiding it. A gutter must be at least 3 % of the page width and have at
  least two lines on each side. Wide lines (>= 72 % of page width, or lines
  crossing a gutter) split the page into horizontal bands; consecutive wide
  lines share a band so a wrapped heading or a wide paragraph still joins up.
  Each band is read column by column, left to right. This handles headings that
  span two columns, but not complex magazine grids, tables or interleaved
  sidebars.
- **Headings:** body size is a character-weighted median font size. `>= 1.55×`
  becomes `<h2>`, `>= 1.18×` (and short) becomes `<h3>`. Bold is read from the
  embedded font name (`Roboto-Bold`, `Inter-SemiBold`, …) through pdf.js
  `commonObjs`; a short bold line without sentence punctuation is an `<h3>` at
  `>= 0.98×` body size, which catches section titles set only one point larger
  than the text. A bold sentence (ends with `.`) or a run-in label (ends with
  `:`) stays a paragraph. Text below `0.84×` the body size gets the smaller
  `is-small` style. These are heuristics, exposed as constants in
  `src/reflow.js`.
- **Tables:** ruled tables are detected from vector rules, not from text
  layout alone. `src/tableDetect.js` walks `constructPath` operators, tracks the
  transform stack, and clusters collinear strokes into horizontal and vertical
  lines. Lines that intersect form a grid component; cell-sized rectangles add
  their four edges only when no drawn grid covers them, because wrapped text
  gives neighbouring cell boxes different heights and their extra edges would
  create empty half-rows. Text items are assigned by their centre point, then
  joined within the cell (wrapped lines with a space, split glyph runs without
  one). A cell also keeps its own paragraph structure: the extra baseline gap
  left by a blank line starts a new paragraph, and each paragraph keeps styled
  runs. A study-guide cell that reads "Bedrock runs …" / "Metrics: …" /
  "Best For: …" therefore renders as three paragraphs with the labels in bold
  instead of one run-on string. A table is rejected when the grid is mostly empty, fewer than 60 % of
  rows have two or more cells, or a column is barely used; this filters
  bordered callouts and code listings. The grid is removed from the normal line
  flow before column detection, so table gutters cannot masquerade as page
  columns, and the reader renders one `<table>` block in its place.
- **Contents pages:** a printed table of contents is not prose. A title line
  with a right-aligned number on the same baseline, or a line with dot leaders,
  is collected as an entry; three or more consecutive entries become a `toc`
  block. Levels come from the title's left edge (the Tutorials Dojo TOC uses
  36/54/72/90 pt, giving four levels). The reader renders each entry as a flex
  row with a dotted leader and a tabular page number, so titles and numbers
  never merge into a paragraph. The marginal filter keeps a numeric line when
  it shares a baseline with a title to its left, but still drops a running page
  number in the bottom margin — including one sitting beside a footer URL.
- **Lists:** a leading bullet (`●`, `○`, `•`, `▪`, `■`, `◆`, `✓`, `-`, `–`) or
  ordered marker (`1.`, `2)`, `(3)`, `a)`) opens a list item. Each item is a
  line; nesting comes from the item's left edge relative to the previous item,
  so the Tutorials Dojo sub-bullets at x = 90 under items at x = 54 become
  level 1, and the filled squares (`■`) at x = 126 under a sub-item become
  level 2. Missing the filled square once merged a whole `Log:` sub-list into
  its parent line.
  Wrapped lines continue at the item's text indent and are joined; a paragraph
  at the column edge flushes the list. The reader rebuilds nested `<ul>`/`<ol>`
  elements from the flat item list. Uppercase `A.` is not treated as a marker
  because it is usually a name initial.
- **Paragraph indents:** only the first line of an indented paragraph steps in.
  A line is compared with the line above as well as the column margin, so the
  continuation lines of an indented paragraph are not split into separate
  blocks.
- **Page backgrounds:** a raster covering at least 35 % of the page with at
  least two of the page's text lines on top of it is a page background (an OCR
  scan, a screenshot of the content block, a watermark) and is skipped on text
  pages. A single line on top is enough when the raster covers 45 % of the
  page. A smaller raster still counts when it covers at least 12 % of the page
  and three or more text lines sit on it: the study guide paints its pale blue
  `Use Cases` callout panels as rasters a quarter of a page tall, then sets the
  real text on top. Figures and UI screenshots carry their own pixels, so no
  text-layer line centre falls inside them and they stay in the flow. The Tutorials Dojo study guide paints a 562 x 422 screenshot of the
  whole content block on every page *and* keeps a real text layer; without this
  rule page 80 shows that screenshot plus its own diagram and reflowed text.
  A figure with text only above and below it has no line centres inside its
  rectangle, so it is kept, and a large figure with one label line under 45 %
  of the page survives too.
- **Header/footer images:** `src/imagePlacement.js` holds the geometry in a
  pure module so it can be unit tested. A placement is page furniture when
  more than half its height overlaps the top or bottom 12 % band, when it lies
  wholly inside the outer 15 % band (wide banners, oversized logos), or when it
  is at most 10 % of the page tall and hugs the top or bottom fifth. The zones
  are fractions of the page height, so they scale with A4, Letter and other
  sizes. Vector rules and text headers are unaffected; they never become image
  blocks.
- **Inline images:** raster placements come from the page operator list, with
  the graphics transform stack tracked to get each image rectangle. Pieces
  under 20 pt per side are ignored. Placements over 78 % of the page area are
  marked page-sized: on a text page they are backgrounds and are skipped (they
  would duplicate the reflowed text), while on a page with no text layer the
  page image is kept and becomes an `image` block. The page is rendered once at
  up to 2× and each rectangle is cropped from the composited canvas to WebP
  (PNG fallback), which preserves masks and transparency; crops are cached per
  page with a 24-page limit. Images become zero-text lines at their top edge for
  ordering and `image` blocks for rendering, so they stay interleaved with the
  text in both reading modes. Vector-only figures are not extracted.
- **Instant layout compensation:** navigation passes an explicit scroll
  behaviour. The global CSS `scroll-behavior` is `auto` so the reader's
  anchor-hold correction is not itself animated, which would turn the
  correction into a feedback loop while lazy pages and images change height.
- **Quality guard:** a page with no text items is treated as scanned. If it has
  a raster page image, that image is shown inline in the reading flow with a
  notice and the original view stays one click away; a vector-only scanned page
  falls back to the original canvas because there is nothing to reflow. The
  reader never switches to the original view on its own, so a page with a
  single heading still reflows. Pages with fewer than five lines, many
  ambiguous column assignments or more than four columns keep the reflow but
  show a warning with a one-click switch to the original page.
- **Paginated mode:** the current PDF page's reflowed text is laid out in CSS
  `column-width: <viewport>` columns with a fixed column height; the column
  strip scrolls horizontally, one screen at a time. At the end of a page it
  advances to the next PDF page. This is deliberately per-PDF-page rather than a
  single 500-page multicol container, which would be very expensive to lay out.
- **OCR:** no OCR engine is bundled (it would add several megabytes and is not
  required). `src/ocr.js` exposes `registerOcrEngine()` plus a disabled "Try
  OCR" button. A local Tesseract.js worker can be registered from the console or
  a small optional module without changing the reader.
- **Search:** scans text page by page in the background, yielding between
  chunks. It can be cancelled by changing the query. Highlighting is applied to
  the rendered page with `<mark>` elements. Because search matches raw lines
  while display matches joined paragraphs, per-page hit counts can occasionally
  differ around hyphenated line breaks.
- **Rotated pages:** text coordinates are read in unrotated PDF space, so a
  `/Rotate 90` page may produce odd column detection in reflow view. The
  original-page view always displays correctly. Documented as a limitation.

## 4. Non-goals

No annotation editing, bookmarks, sync, analytics, uploading, cloud OCR, DRM
removal, form handling, tables, equations or accessibility tree reconstruction
from tagged PDFs. The app does not modify PDFs.
