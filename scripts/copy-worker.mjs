// Copies pdf.js runtime assets out of node_modules into public/ so the built
// app has no runtime dependency on a CDN and works fully offline.
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pdfDist = resolve(root, 'node_modules/pdfjs-dist');
const publicDir = resolve(root, 'public');

if (!existsSync(pdfDist)) {
  console.error('[pdfreader] pdfjs-dist is not installed yet. Run npm install first.');
  process.exit(1);
}

mkdirSync(publicDir, { recursive: true });

const files = [
  ['build/pdf.worker.min.mjs', 'pdf.worker.min.mjs'],
  ['LICENSE', 'pdfjs-LICENSE.txt'],
];

for (const [from, to] of files) {
  const src = resolve(pdfDist, from);
  const dest = resolve(publicDir, to);
  if (existsSync(src)) cpSync(src, dest);
}

for (const dir of ['cmaps', 'standard_fonts']) {
  const src = resolve(pdfDist, dir);
  const dest = resolve(publicDir, 'pdfjs', dir);
  if (!existsSync(src)) continue;
  rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, { recursive: true });
}

const worker = resolve(publicDir, 'pdf.worker.min.mjs');
if (!existsSync(worker)) {
  console.error('[pdfreader] Could not copy the pdf.js worker.');
  process.exit(1);
}
console.log('[pdfreader] pdf.js worker, cmaps and standard fonts are ready in public/.');
