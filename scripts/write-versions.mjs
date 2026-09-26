#!/usr/bin/env node
// Regenerates every package's baked-in version file from its package.json.
// `changeset version` bumps package.json but not these, so the release PR
// would otherwise commit a version file one release behind. With --check it
// writes nothing and exits 1 when any file is stale, for CI.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');
const scripts = globSync('{apps,packages}/*/scripts/write-version.mjs', { cwd: root }).sort();

let stale = 0;
for (const rel of scripts) {
  const pkgDir = join(root, rel, '..', '..');
  const out = join(pkgDir, 'src', 'version.generated.ts');
  const before = readFileSync(out, 'utf8');
  execFileSync(process.execPath, [join(root, rel)], { stdio: 'inherit' });
  const after = readFileSync(out, 'utf8');
  if (before !== after) {
    stale += 1;
    const name = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).name;
    console.log(`${check ? 'stale' : 'updated'}  ${name}`);
    // Put back exactly what was there, so --check never changes the tree.
    if (check) writeFileSync(out, before);
  }
}
if (check && stale > 0) {
  console.log(`\n${stale} version file(s) do not match package.json; run node scripts/write-versions.mjs`);
  process.exit(1);
}
console.log(`${scripts.length} version file(s) checked`);
