/**
 * deploy-pages.mjs
 *
 * Build the production bundle and publish it to `docs/` on the `main` branch,
 * which GitHub Pages serves at https://mrlearner1606.github.io/reflow/.
 *
 * GitHub Pages is configured as "Deploy from a branch": `main` / `docs`. There
 * is no `gh-pages` branch, and no Actions workflow is required.
 *
 * `public/test/` (the local copy of a copyrighted study guide) is removed from
 * the published bundle, so it never reaches the repository.
 *
 * Usage: npm run deploy
 */

import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function run(command, args) {
  execFileSync(command, args, { cwd: root, stdio: 'inherit' });
}

run('npx', ['vite', 'build', '--outDir', 'docs', '--emptyOutDir']);

const docs = join(root, 'docs');
rmSync(join(docs, 'test'), { recursive: true, force: true });
writeFileSync(join(docs, '.nojekyll'), '');

if (!existsSync(join(docs, 'index.html'))) {
  throw new Error('Build produced no docs/index.html — aborting deploy.');
}

run('git', ['add', '-A', 'docs']);
const staged = execFileSync('git', ['status', '--porcelain', '--', 'docs'], { cwd: root })
  .toString()
  .trim();
if (staged) {
  run('git', ['commit', '-m', 'Deploy Reflow', '--', 'docs']);
} else {
  console.log('Build output is unchanged; nothing new to commit.');
}
run('git', ['push', 'origin', 'HEAD:main']);
console.log('Published the build to docs/ on the main branch.');
