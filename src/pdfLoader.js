/**
 * pdfLoader.js
 * Thin, browser-only wrapper around pdfjs-dist. Keeps pdf.js details out of the
 * reader and reflow modules.
 */

import * as pdfjsLib from 'pdfjs-dist';
import { groupLines } from './reflow.js';
import { detectTables, extractRules } from './tableDetect.js';
import { isMarginalImagePlacement, MARGINAL_ZONE } from './imagePlacement.js';

const BASE = import.meta.env.BASE_URL || './';
pdfjsLib.GlobalWorkerOptions.workerSrc = `${BASE}pdf.worker.min.mjs`;

/** Cropped figure data URLs are memory-hungry; keep only recent pages. */
const IMAGE_CACHE_PAGE_LIMIT = 24;

function resolveAsset(path) {
  return new URL(path, document.baseURI).href;
}

/**
 * pdf.js exposes the embedded font object through `commonObjs`. Its name
 * carries the weight (`Roboto-Bold`, `Inter-SemiBold`, ...), which is the only
 * reliable bold signal: the text item itself has no weight field.
 */
function fontLooksBold(page, fontName) {
  if (!fontName) return false;
  try {
    const font = page.commonObjs.get(fontName);
    const name = String(font?.name || font?.fallbackName || '');
    if (!name) return false;
    if (/(bold|semibold|demi|black|heavy)/i.test(name)) return true;
    return /[-_]([6-9]00)(?:[^0-9]|$)/.test(name);
  } catch {
    return false;
  }
}

export class PasswordException extends Error {
  constructor(message, incorrect = false) {
    super(message);
    this.name = 'PasswordException';
    this.incorrect = incorrect;
  }
}

export class PdfBook {
  constructor(pdf, loadingTask) {
    this.pdf = pdf;
    this.loadingTask = loadingTask;
    this.numPages = pdf.numPages;
    this.metadata = {};
    this.outline = [];
    this._pages = new Map();
    this._linePromises = new Map();
    this._imagePromises = new Map();
    this._imageData = new Map();
    this._renderTasks = new Map();
    this.destroyed = false;
  }

  static async open({ data, password, onProgress, requestPassword }) {
    if (!data || !data.byteLength) throw new Error('The file is empty.');

    const source = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (!source.byteLength) throw new Error('The file is empty.');

    const loadingTask = pdfjsLib.getDocument({
      // pdf.js may transfer the backing buffer to its worker. Keep this copy
      // for retries (for example after an incorrect password).
      data: new Uint8Array(source),
      password: password || undefined,
      cMapUrl: resolveAsset('pdfjs/cmaps/'),
      cMapPacked: true,
      standardFontDataUrl: resolveAsset('pdfjs/standard_fonts/'),
      disableFontFace: false,
      useSystemFonts: true,
      isEvalSupported: true,
      useWorkerFetch: true,
    });

    loadingTask.onProgress = (progress) => {
      if (onProgress && progress?.total) {
        onProgress({
          loaded: progress.loaded,
          total: progress.total,
          ratio: Math.min(1, progress.loaded / progress.total),
        });
      }
    };

    let pdf;
    try {
      pdf = await loadingTask.promise;
    } catch (error) {
      // pdf.js reports missing/wrong passwords as PasswordException. We ask for
      // the password outside pdf.js so retries start from a clean loading task.
      if (error?.name === 'PasswordException') {
        if (requestPassword) {
          const next = await requestPassword({
            incorrect: Boolean(error.code === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD),
          });
          if (next === null || next === undefined) {
            throw new PasswordException('A password is required to open this PDF.', false);
          }
          return PdfBook.open({ data, password: next, onProgress, requestPassword });
        }
        throw new PasswordException('A password is required to open this PDF.', false);
      }
      throw error;
    }

    const book = new PdfBook(pdf, loadingTask);
    await book.#loadMetadata();
    book.outline = await book.#loadOutline();
    return book;
  }

  async #loadMetadata() {
    try {
      const result = await this.pdf.getMetadata();
      const info = result?.info || {};
      this.metadata = {
        title: typeof info.Title === 'string' ? info.Title.trim() : '',
        author: typeof info.Author === 'string' ? info.Author.trim() : '',
        subject: typeof info.Subject === 'string' ? info.Subject.trim() : '',
        creator: typeof info.Creator === 'string' ? info.Creator.trim() : '',
        producer: typeof info.Producer === 'string' ? info.Producer.trim() : '',
      };
    } catch {
      this.metadata = {};
    }
  }

  async #resolveDestination(destination) {
    try {
      const explicit =
        typeof destination === 'string'
          ? await this.pdf.getDestination(destination)
          : destination;
      if (!Array.isArray(explicit) || !explicit.length) return null;
      const reference = explicit[0];
      if (reference && typeof reference === 'object') {
        const index = await this.pdf.getPageIndex(reference);
        return Number.isFinite(index) ? index + 1 : null;
      }
      if (typeof reference === 'number') return Math.max(1, reference + 1);
    } catch {
      return null;
    }
    return null;
  }

  async #loadOutline() {
    let raw;
    try {
      raw = await this.pdf.getOutline();
    } catch {
      return [];
    }
    if (!Array.isArray(raw) || !raw.length) return [];

    const flat = [];
    const walk = async (items, depth) => {
      for (const entry of items) {
        const title = String(entry.title || '').replace(/\s+/g, ' ').trim();
        const page = entry.dest ? await this.#resolveDestination(entry.dest) : null;
        if (title) {
          flat.push({
            title,
            page,
            depth,
            bold: Boolean(entry.bold),
            italic: Boolean(entry.italic),
          });
        }
        if (Array.isArray(entry.items) && entry.items.length && depth < 8) {
          await walk(entry.items, depth + 1);
        }
      }
    };
    await walk(raw, 0);
    return flat;
  }

  async getPage(pageNumber) {
    const n = Math.min(Math.max(1, Math.round(pageNumber)), this.numPages);
    if (!this._pages.has(n)) {
      this._pages.set(n, this.pdf.getPage(n));
    }
    return this._pages.get(n);
  }

  /**
   * Extract lines for a page. Coordinates stay in pdf.js/PDF user space
   * (y grows upward) and are offset by the CropBox origin so margin tests can
   * compare a baseline directly against 0..pageHeight.
   */
  async getPageLines(pageNumber) {
    const n = Math.min(Math.max(1, Math.round(pageNumber)), this.numPages);
    if (!this._linePromises.has(n)) {
      const promise = (async () => {
        const page = await this.getPage(n);
        const view = Array.isArray(page.view) && page.view.length === 4 ? page.view : [0, 0, 612, 792];
        const [x0, y0, x1, y1] = view;
        const width = Math.max(1, x1 - x0);
        const height = Math.max(1, y1 - y0);
        const content = await page.getTextContent({
          includeMarkedContent: false,
          disableNormalization: false,
        });
        // Font weights live in the operator list's common objects. The list is
        // cached by pdf.js and image extraction asks for it anyway.
        let items = content.items;
        let ops = null;
        try {
          ops = await page.getOperatorList();
          items = items.map((item) => {
            if (!item || !item.fontName) return item;
            return fontLooksBold(page, item.fontName) ? { ...item, bold: true } : item;
          });
        } catch {
          // Font metadata is optional; size-only headings still work.
        }
        const lines = groupLines(items).map((line) => ({
          ...line,
          x: line.x - x0,
          y: line.y - y0,
        }));

        // Ruled tables are read from the same operator list. Text keeps its
        // own coordinates so each run can be assigned to a cell.
        let tables = [];
        if (ops) {
          try {
            const { rules, rects } = extractRules(ops.fnArray, ops.argsArray, pdfjsLib.OPS, {
              x0,
              y0,
              pageWidth: width,
              pageHeight: height,
            });
            const positioned = items
              .filter((item) => item && item.str && item.str.trim())
              .map((item) => ({
                ...item,
                x: item.transform[4] - x0,
                y: item.transform[5] - y0,
              }));
            tables = detectTables({
              items: positioned,
              rules,
              rects,
              pageWidth: width,
              pageHeight: height,
            });
          } catch {
            // A malformed content stream should never hide the page text.
            tables = [];
          }
        }
        return { lines, tables, pageWidth: width, pageHeight: height };
      })();
      this._linePromises.set(n, promise);
    }
    return this._linePromises.get(n);
  }

  /**
   * Rectangles of raster images painted on a page, in PDF points with the
   * CropBox origin removed. Text and vector art are ignored.
   */
  async getPageImages(pageNumber, { marginalZone = MARGINAL_ZONE, excludeMarginal = true } = {}) {
    const n = Math.min(Math.max(1, Math.round(pageNumber)), this.numPages);
    if (!this._imagePromises.has(n)) {
      const promise = (async () => {
        const page = await this.getPage(n);
        const view = Array.isArray(page.view) && page.view.length === 4 ? page.view : [0, 0, 612, 792];
        const [x0, y0, x1, y1] = view;
        const pageWidth = Math.max(1, x1 - x0);
        const pageHeight = Math.max(1, y1 - y0);
        const ops = await page.getOperatorList();
        const { OPS } = pdfjsLib;

        let ctm = [1, 0, 0, 1, 0, 0];
        const stack = [];
        const images = [];
        const seen = new Set();

        const multiply = (m, t) => [
          m[0] * t[0] + m[2] * t[1],
          m[1] * t[0] + m[3] * t[1],
          m[0] * t[2] + m[2] * t[3],
          m[1] * t[2] + m[3] * t[3],
          m[0] * t[4] + m[2] * t[5] + m[4],
          m[1] * t[4] + m[3] * t[5] + m[5],
        ];

        for (let i = 0; i < ops.fnArray.length; i += 1) {
          const fn = ops.fnArray[i];
          const args = ops.argsArray[i];
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
          const isImage =
            fn === OPS.paintImageXObject ||
            fn === OPS.paintJpegXObject ||
            fn === OPS.paintInlineImageXObject;
          if (!isImage) continue;

          // The unit square is mapped through the current transform. Taking
          // the bounding box also handles flips and rotated placements.
          const corners = [
            [ctm[4], ctm[5]],
            [ctm[0] + ctm[4], ctm[1] + ctm[5]],
            [ctm[2] + ctm[4], ctm[3] + ctm[5]],
            [ctm[0] + ctm[2] + ctm[4], ctm[1] + ctm[3] + ctm[5]],
          ];
          const xs = corners.map(([x]) => x);
          const ys = corners.map(([, y]) => y);
          const left = Math.max(0, Math.min(...xs) - x0);
          const right = Math.min(pageWidth, Math.max(...xs) - x0);
          const bottom = Math.max(0, Math.min(...ys) - y0);
          const top = Math.min(pageHeight, Math.max(...ys) - y0);
          const width = right - left;
          const height = top - bottom;
          if (width < 20 || height < 20) continue;

          const area = width * height;
          // Very small marks are decoration. Large placements are marked so
          // the reader can treat them as page backgrounds on text pages and
          // as the page image on image-only pages.
          const fullPage = area > pageWidth * pageHeight * 0.78;

          // Logos, rules and ornaments in the running head or footer are part
          // of the page furniture, not figures in the text.
          if (
            excludeMarginal &&
            isMarginalImagePlacement({
              x: left,
              y: bottom,
              width,
              height,
              pageWidth,
              pageHeight,
              marginalZone,
            })
          ) {
            continue;
          }

          const key = [left, bottom, width, height]
            .map((value) => Math.round(value * 10) / 10)
            .join(':');
          if (seen.has(key)) continue;
          seen.add(key);

          images.push({
            id: `p${n}-i${images.length}`,
            x: left,
            y: bottom,
            width,
            height,
            fullPage,
          });
        }

        // Reading order: top to bottom, then left to right.
        return images.sort((a, b) => b.y + b.height - (a.y + a.height) || a.x - b.x);
      })();
      this._imagePromises.set(n, promise);
    }
    return this._imagePromises.get(n);
  }

  /**
   * Render the page once and crop every supplied image rectangle to a data
   * URL. Rendering the composited page preserves masks and transparency.
   */
  async renderPageImages(pageNumber, images, { maxWidth = 1400 } = {}) {
    const n = Math.min(Math.max(1, Math.round(pageNumber)), this.numPages);
    const wanted = Array.isArray(images) ? images : [];
    if (!wanted.length) return new Map();

    const cache = this._touchImageCache(n);
    const missing = wanted.filter((image) => !cache.has(image.id));
    if (!missing.length) {
      return new Map(wanted.map((image) => [image.id, cache.get(image.id)]));
    }

    const page = await this.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(2, Math.max(1, 1500 / base.width));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    const context = canvas.getContext('2d', { alpha: false });
    context.save();
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.restore();

    const task = page.render({ canvasContext: context, viewport });
    try {
      await task.promise;
    } catch (error) {
      if (error?.name !== 'RenderingCancelledException') throw error;
      return new Map();
    }

    for (const image of missing) {
      const sourceWidth = image.width * scale;
      const sourceHeight = image.height * scale;
      const sourceX = image.x * scale;
      const sourceY = (base.height - (image.y + image.height)) * scale;
      const ratio = Math.min(1, maxWidth / Math.max(1, sourceWidth));
      const outWidth = Math.max(1, Math.round(sourceWidth * ratio));
      const outHeight = Math.max(1, Math.round(sourceHeight * ratio));
      const crop = document.createElement('canvas');
      crop.width = outWidth;
      crop.height = outHeight;
      const cropContext = crop.getContext('2d', { alpha: false });
      cropContext.fillStyle = '#ffffff';
      cropContext.fillRect(0, 0, outWidth, outHeight);
      cropContext.drawImage(
        canvas,
        Math.max(0, sourceX),
        Math.max(0, sourceY),
        sourceWidth,
        sourceHeight,
        0,
        0,
        outWidth,
        outHeight,
      );
      let url = '';
      try {
        url = crop.toDataURL('image/webp', 0.92);
      } catch {
        url = crop.toDataURL('image/png');
      }
      cache.set(image.id, url);
    }

    return new Map(wanted.map((image) => [image.id, cache.get(image.id)]));
  }

  async getPageText(pageNumber) {
    const { lines } = await this.getPageLines(pageNumber);
    return lines.map((line) => line.text).join(' ');
  }

  /**
   * Render a page into a canvas. Returns the CSS pixel size of the render.
   * `width`/`height` are maximum CSS pixel bounds.
   */
  async renderPage(pageNumber, canvas, options = {}) {
    const page = await this.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    const dpr = Math.min(options.dpr || window.devicePixelRatio || 1, 3);
    const maxWidth = options.width || base.width;
    const maxHeight = options.height || base.height;
    let scale = Math.min(maxWidth / base.width, maxHeight / base.height);
    if (!Number.isFinite(scale) || scale <= 0) scale = 1;
    if (options.zoom) scale *= options.zoom;

    const viewport = page.getViewport({ scale: scale * dpr });
    const cssWidth = viewport.width / dpr;
    const cssHeight = viewport.height / dpr;

    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;

    const context = canvas.getContext('2d', { alpha: false });
    context.save();
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.restore();

    const previous = this._renderTasks.get(canvas);
    if (previous) {
      try {
        previous.cancel();
      } catch {
        /* already finished */
      }
    }

    const task = page.render({ canvasContext: context, viewport });
    this._renderTasks.set(canvas, task);
    try {
      await task.promise;
    } catch (error) {
      if (error?.name !== 'RenderingCancelledException') throw error;
    } finally {
      if (this._renderTasks.get(canvas) === task) this._renderTasks.delete(canvas);
    }

    return { width: cssWidth, height: cssHeight, scale };
  }

  _touchImageCache(pageNumber) {
    let cache = this._imageData.get(pageNumber);
    if (cache) {
      // Refresh recency so the pages being read are the last to be evicted.
      this._imageData.delete(pageNumber);
      this._imageData.set(pageNumber, cache);
      return cache;
    }
    cache = new Map();
    this._imageData.set(pageNumber, cache);
    while (this._imageData.size > IMAGE_CACHE_PAGE_LIMIT) {
      const oldest = this._imageData.keys().next().value;
      this._imageData.delete(oldest);
    }
    return cache;
  }

  async destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this._imageData.clear();
    this._imagePromises.clear();
    for (const task of this._renderTasks.values()) {
      try {
        task.cancel();
      } catch {
        /* noop */
      }
    }
    try {
      await this.loadingTask?.destroy();
    } catch {
      /* noop */
    }
  }
}

export function getPdfjsVersion() {
  return pdfjsLib.version;
}
