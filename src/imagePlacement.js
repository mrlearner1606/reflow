/**
 * imagePlacement.js
 * Pure geometry for deciding whether a painted image is page furniture (a
 * running-head logo, a rule, a footer ornament) rather than a figure in the
 * text. Kept free of pdf.js so it can be unit tested.
 */

/** Share of the page height treated as the strict running-head/footer band. */
export const MARGINAL_ZONE = 0.12;
/** Wider band: anything wholly inside it is furniture, whatever its size. */
export const OUTER_ZONE = 0.15;
/** Small marks this close to the page edge are logos even inside the text area. */
export const EDGE_ZONE = 0.2;
/** Height share below which a mark counts as small. */
export const SMALL_HEIGHT = 0.1;
/** Share of the page area above which an image can be a page background. */
export const BACKGROUND_MIN_AREA = 0.35;
/** Text lines on top of an image that mark it as a page background. */
export const BACKGROUND_MIN_LINES = 2;
/** A single text line is enough when the image is this large. */
export const BACKGROUND_SINGLE_LINE_AREA = 0.45;

/**
 * @param {object} placement
 * @param {number} placement.x left edge in PDF units
 * @param {number} placement.y bottom edge in PDF units
 * @param {number} placement.width
 * @param {number} placement.height
 * @param {number} pageWidth
 * @param {number} pageHeight
 * @param {number} [marginalZone]
 * @returns {boolean} true when the placement should not become a figure
 */
export function isMarginalImagePlacement({
  x,
  y,
  width,
  height,
  pageWidth,
  pageHeight,
  marginalZone = MARGINAL_ZONE,
}) {
  if (!(pageHeight > 0) || !(width > 0) || !(height > 0)) return false;

  const bottom = y;
  const top = y + height;
  const band = pageHeight * marginalZone;

  // Overlap with the strict top and bottom bands, clipped to the page. A
  // placement is furniture when most of its height sits in a band.
  const topOverlap = Math.max(
    0,
    Math.min(top, pageHeight) - Math.max(bottom, pageHeight - band),
  );
  const bottomOverlap = Math.max(0, Math.min(top, band) - Math.max(bottom, 0));
  if (Math.max(topOverlap, bottomOverlap) > height * 0.5) return true;

  // A banner or an oversized logo can sit wholly in the wider outer band
  // without being "mostly" in the strict one.
  const outer = pageHeight * OUTER_ZONE;
  const insideTop = top <= pageHeight && bottom >= pageHeight - outer;
  const insideBottom = bottom >= 0 && top <= outer;
  if (insideTop || insideBottom) return true;

  // A small mark hugging the top or bottom fifth is a logo or ornament even
  // when it sits just inside the text block.
  const nearEdge = top >= pageHeight * (1 - EDGE_ZONE) || bottom <= pageHeight * EDGE_ZONE;
  const small = height <= pageHeight * SMALL_HEIGHT;
  return nearEdge && small;
}

/**
 * A raster that sits *under* the page's text is a page background: a scan with
 * an invisible OCR layer, a screenshot of the page content, a watermark. Some
 * PDFs paint a screenshot of the whole content block on every page and keep a
 * real text layer on top; rendering that raster inline would repeat the page
 * next to its own reflowed text.
 *
 * A real figure has no text drawn over it — captions sit below the rectangle —
 * so it stays in the reading stream. A large image with a single line on top
 * is only treated as a background when it covers nearly half the page.
 *
 * @param {object} input
 * @param {{x:number,y:number,width:number,height:number}} input.image
 * @param {Array<{x:number,y:number,width:number,fontSize?:number}>} [input.lines]
 * @param {number} input.pageWidth
 * @param {number} input.pageHeight
 * @param {number} [input.minAreaRatio]
 * @param {number} [input.minLines]
 * @param {number} [input.singleLineAreaRatio]
 * @returns {boolean}
 */
export function isPageBackgroundImage({
  image,
  lines = [],
  pageWidth,
  pageHeight,
  minAreaRatio = BACKGROUND_MIN_AREA,
  minLines = BACKGROUND_MIN_LINES,
  singleLineAreaRatio = BACKGROUND_SINGLE_LINE_AREA,
}) {
  if (!image || !(pageWidth > 0) || !(pageHeight > 0)) return false;
  if (!(image.width > 0) || !(image.height > 0)) return false;

  const area = image.width * image.height;
  if (area < pageWidth * pageHeight * minAreaRatio) return false;

  const rows = Array.isArray(lines) ? lines : [];
  if (!rows.length) return false;

  let inside = 0;
  for (const line of rows) {
    const fontSize =
      Number.isFinite(line.fontSize) && line.fontSize > 0 ? line.fontSize : 10;
    const cx = line.x + line.width / 2;
    const cy = line.y + fontSize / 2;
    if (
      cx >= image.x &&
      cx <= image.x + image.width &&
      cy >= image.y &&
      cy <= image.y + image.height
    ) {
      inside += 1;
    }
  }

  if (inside >= minLines) return true;
  return inside >= 1 && area >= pageWidth * pageHeight * singleLineAreaRatio;
}
