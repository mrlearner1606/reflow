import { describe, expect, it } from 'vitest';
import {
  BACKGROUND_DENSE_AREA,
  BACKGROUND_DENSE_LINES,
  BACKGROUND_MIN_AREA,
  BACKGROUND_MIN_LINES,
  BACKGROUND_SINGLE_LINE_AREA,
  EDGE_ZONE,
  MARGINAL_ZONE,
  OUTER_ZONE,
  isMarginalImagePlacement,
  isPageBackgroundImage,
} from '../src/imagePlacement.js';

// A4 in PDF units, the page size used by the bundled sample.
const PAGE = { pageWidth: 595.92, pageHeight: 842.88 };

function place(overrides = {}) {
  return { x: 40, y: 400, width: 200, height: 100, ...PAGE, ...overrides };
}

describe('isMarginalImagePlacement', () => {
  it('keeps a figure inside the text block', () => {
    // The body figure from the sample: y 496..640.
    expect(isMarginalImagePlacement(place({ y: 496, height: 144 }))).toBe(false);
  });

  it('drops a logo in the running head', () => {
    // Header logo: y 783..823, inside the top 12 % band.
    expect(
      isMarginalImagePlacement(place({ y: 783, width: 40, height: 40 })),
    ).toBe(true);
  });

  it('drops a footer ornament', () => {
    expect(
      isMarginalImagePlacement(place({ y: 13, width: 30, height: 30 })),
    ).toBe(true);
  });

  it('drops a wide banner sitting wholly in the top outer band', () => {
    // 70 pt tall banner starting below the strict band but inside 15 %.
    expect(
      isMarginalImagePlacement(place({ y: 760, width: 500, height: 70 })),
    ).toBe(true);
  });

  it('drops an oversized header logo that is mostly in the band', () => {
    // 150 pt tall logo: 88 pt of it overlap the top band.
    expect(
      isMarginalImagePlacement(place({ y: 680, width: 150, height: 150 })),
    ).toBe(true);
  });

  it('keeps a tall figure that only reaches into the band', () => {
    // 300 pt tall figure: 100 pt in the band, well under half its height.
    expect(
      isMarginalImagePlacement(place({ y: 542, width: 400, height: 300 })),
    ).toBe(false);
  });

  it('drops a small mark hugging the top fifth of the page', () => {
    expect(
      isMarginalImagePlacement(place({ y: 690, width: 60, height: 40 })),
    ).toBe(true);
  });

  it('keeps a small figure in the middle of the page', () => {
    expect(
      isMarginalImagePlacement(place({ y: 420, width: 60, height: 40 })),
    ).toBe(false);
  });

  it('drops an image clipped by the page edge', () => {
    expect(
      isMarginalImagePlacement(place({ y: 800, width: 200, height: 80 })),
    ).toBe(true);
  });

  it('ignores empty rectangles', () => {
    expect(isMarginalImagePlacement(place({ width: 0 }))).toBe(false);
    expect(isMarginalImagePlacement(place({ height: 0 }))).toBe(false);
    expect(
      isMarginalImagePlacement({ ...place(), pageHeight: 0 }),
    ).toBe(false);
  });

  it('honours a custom marginal zone', () => {
    const header = place({ y: 783, width: 40, height: 40 });
    expect(isMarginalImagePlacement(header)).toBe(true);
    // A zero band disables the strict overlap test; the small near-edge rule
    // still catches a logo this close to the top.
    expect(isMarginalImagePlacement({ ...header, marginalZone: 0 })).toBe(true);
    // A mid-page figure stays visible with a zero band as well.
    expect(
      isMarginalImagePlacement({ ...place(), marginalZone: 0 }),
    ).toBe(false);
  });

  it('exposes its thresholds', () => {
    expect(MARGINAL_ZONE).toBeLessThan(OUTER_ZONE);
    expect(OUTER_ZONE).toBeLessThan(EDGE_ZONE);
  });
});

describe('isPageBackgroundImage', () => {
  // A scan that covers most of the page, with an invisible OCR text layer.
  const pageImage = { x: 30, y: 40, width: 535, height: 760 };

  function textLines(count, { inside = true } = {}) {
    return Array.from({ length: count }, (_, i) => ({
      x: 70,
      y: inside ? 700 - i * 22 : 0 - i * 22,
      width: 420,
      fontSize: 11,
    }));
  }

  it('drops a page-sized scan that sits under the text layer', () => {
    expect(
      isPageBackgroundImage({
        image: pageImage,
        lines: textLines(20),
        ...PAGE,
      }),
    ).toBe(true);
  });

  it('keeps a page-sized illustration with only a caption below it', () => {
    expect(
      isPageBackgroundImage({
        image: pageImage,
        lines: textLines(3, { inside: false }),
        ...PAGE,
      }),
    ).toBe(false);
  });

  it('drops a callout panel with the text drawn over it', () => {
    // The pale blue `Use Cases` boxes: about a fifth of the page, but five or
    // more lines of the real text layer sit on top of the raster.
    const panel = { x: 46, y: 330, width: 500, height: 210 };
    const lines = Array.from({ length: 8 }, (_, i) => ({
      x: 70,
      y: 500 - i * 22,
      width: 420,
      fontSize: 11,
    }));
    expect(
      isPageBackgroundImage({ image: panel, lines, ...PAGE }),
    ).toBe(true);
  });

  it('keeps an illustration with text only below it', () => {
    const figure = { x: 60, y: 400, width: 420, height: 300 };
    expect(
      isPageBackgroundImage({
        image: figure,
        lines: textLines(5, { inside: false }),
        ...PAGE,
      }),
    ).toBe(false);
  });

  it('keeps a figure with a single overlaid label', () => {
    const figure = { x: 60, y: 400, width: 420, height: 300 };
    expect(
      isPageBackgroundImage({
        image: figure,
        lines: [{ x: 70, y: 690, width: 420, fontSize: 11 }],
        ...PAGE,
      }),
    ).toBe(false);
  });

  it('keeps images on pages with no text layer', () => {
    expect(
      isPageBackgroundImage({ image: pageImage, lines: [], ...PAGE }),
    ).toBe(false);
  });

  it('drops a half-page background under most of the text', () => {
    const background = { x: 0, y: 0, width: 595.92, height: 500 };
    const lines = Array.from({ length: 12 }, (_, i) => ({
      x: 70,
      y: 460 - i * 22,
      width: 420,
      fontSize: 11,
    }));
    expect(
      isPageBackgroundImage({ image: background, lines, ...PAGE }),
    ).toBe(true);
  });

  it('drops a content screenshot when only one line sits on it', () => {
    // The book paints a 562 x 422 screenshot of the whole content block on
    // every page. Some pages have only one text line inside it.
    const screenshot = { x: 36, y: 270, width: 562, height: 422 };
    const lines = [
      { x: 70, y: 300, width: 420, fontSize: 11 },
      { x: 70, y: 100, width: 420, fontSize: 11 },
      { x: 70, y: 70, width: 420, fontSize: 11 },
    ];
    expect(
      isPageBackgroundImage({ image: screenshot, lines, ...PAGE }),
    ).toBe(true);
  });

  it('keeps a large figure with one label when it is under half the page', () => {
    const figure = { x: 38, y: 358, width: 540, height: 326 };
    const lines = [
      { x: 70, y: 500, width: 420, fontSize: 11 },
      { x: 70, y: 100, width: 420, fontSize: 11 },
      { x: 70, y: 70, width: 420, fontSize: 11 },
    ];
    expect(
      isPageBackgroundImage({ image: figure, lines, ...PAGE }),
    ).toBe(false);
  });

  it('exposes its thresholds', () => {
    expect(BACKGROUND_DENSE_AREA).toBeGreaterThan(0);
    expect(BACKGROUND_DENSE_AREA).toBeLessThan(BACKGROUND_MIN_AREA);
    expect(BACKGROUND_MIN_AREA).toBeLessThan(BACKGROUND_SINGLE_LINE_AREA);
    expect(BACKGROUND_SINGLE_LINE_AREA).toBeLessThan(1);
    expect(BACKGROUND_MIN_LINES).toBeGreaterThanOrEqual(1);
    expect(BACKGROUND_DENSE_LINES).toBeGreaterThan(BACKGROUND_MIN_LINES);
  });
});
