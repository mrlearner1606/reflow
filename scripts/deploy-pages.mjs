/**
 * deploy-pages.mjs
 *
 * Build the production bundle and publish it to the `gh-pages` branch, which
 * GitHub Pages serves at https://mrlearner1606.github.io/reflow/.
 *
 * The build output is copied to a temporary directory first, so the working
 * tree and the main branch are never rewritten. `public/test/` (the local
 * copy of a copyrighted study guide) is removed from the published bundle.
 *
 * Usage: npm run deploy
 */

import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: 'inherit' });
}

run('npm', ['run', 'build'], root);

const dist = join(root, 'dist');
rmSync(join(dist, 'test'), { recursive: true, force: true });
writeFileSync(join(dist, '.nojekyll'), '');

const remote = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: root })
  .toString()
  .trim();
if (!remote) {
  throw new Error('No `origin` remote. Add one with `git remote add origin <url>`.');
}

const stage = mkdtempSync(join(tmpdir(), 'reflow-pages-'));
try {
  cpSync(dist, stage, { recursive: true });
  run('git', ['init', '-b', 'gh-pages'], stage);
  run('git', ['config', 'user.name', 'mrlearner1606'], stage);
  run('git', ['config', 'user.email', '112171502+mrlearner1606@users.noreply.github.com'], stage);
  run('git', ['add', '-A'], stage);
  run('git', ['commit', '-m', 'Deploy Reflow'], stage);
  run('git', ['remote', 'add', 'origin', remote], stage);
  run('git', ['push', '--force', 'origin', 'gh-pages'], stage);
  console.log('Published the build to the gh-pages branch.');
} finally {
  rmSync(stage, { recursive: true, force: true });
}
