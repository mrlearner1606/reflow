/**
 * ocr.js
 * A deliberately small hook, not a bundled OCR engine.
 *
 * To use Tesseract.js locally, install it and register an adapter before the
 * reader needs it, for example from src/main.js:
 *
 *   import { createWorker } from 'tesseract.js';
 *   import { registerOcrEngine } from './ocr.js';
 *   let worker;
 *   registerOcrEngine(async ({ canvas, onProgress }) => {
 *     worker ||= await createWorker('eng');
 *     const result = await worker.recognize(canvas);
 *     return result.data.text;
 *   });
 *
 * Keep tesseract.js, its worker and its language data inside the project (no
 * CDN) so the app remains offline and local-only.
 */

let engine = null;

export function registerOcrEngine(fn) {
  engine = typeof fn === 'function' ? fn : null;
}

export function unregisterOcrEngine() {
  engine = null;
}

export function isOcrAvailable() {
  return typeof engine === 'function';
}

/**
 * Recognize text from a rendered page canvas.
 * Returns null when no engine has been registered.
 */
export async function recognizePage({ canvas, pageNumber, onProgress }) {
  if (!engine || !canvas) return null;
  const text = await engine({ canvas, pageNumber, onProgress });
  return typeof text === 'string' ? text : null;
}
