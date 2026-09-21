// Builds the fake package tree the harnesses resolve against, in a temp dir.
//
// Generated rather than committed: a directory named node_modules is ignored
// by git, so a committed fixture tree would exist only on the machine that
// wrote it and every one of these tests would silently pass nowhere else.
import { mkdirSync, writeFileSync, copyFileSync, readdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const PACKAGES = [
  // A CJS entry, which is also what ESM resolves to for a dual package.
  { dir: 'langchain', pkg: { name: 'langchain', version: '1.5.11', main: 'index.cjs' }, file: ['index.cjs', 'module.exports = { chain: true };'] },
  { dir: '@langchain/core', pkg: { name: '@langchain/core', version: '1.2.12', main: 'index.cjs' }, file: ['index.cjs', 'module.exports = { core: true };'] },
  // ESM only: invisible to require.cache, so only the resolve hook sees it.
  { dir: '@mastra/core', pkg: { name: '@mastra/core', version: '1.67.0', type: 'module', main: 'index.js' }, file: ['index.js', 'export const mastra = true;'] },
];

export function makeFixtureTree(fixturesDir) {
  const root = mkdtempSync(join(tmpdir(), 'aer-fx-'));
  for (const { dir, pkg, file } of PACKAGES) {
    const target = join(root, 'node_modules', ...dir.split('/'));
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'package.json'), JSON.stringify(pkg));
    writeFileSync(join(target, file[0]), file[1]);
  }
  for (const name of readdirSync(fixturesDir)) {
    if (name.endsWith('.mjs') && name !== 'tree.mjs') copyFileSync(join(fixturesDir, name), join(root, name));
  }
  return root;
}
