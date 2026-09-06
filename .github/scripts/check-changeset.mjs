// A change to a published package with no changeset never ships: the version
// pull request will not carry it, so the fix sits on main looking released.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const base = process.env.BASE_SHA;
const head = process.env.HEAD_SHA;
if (!base || !head) {
  console.log('no pull-request range available, skipping');
  process.exit(0);
}

const changed = execFileSync('git', ['diff', '--name-only', `${base}...${head}`], {
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean);

const published = new Set();
for (const file of changed) {
  const m = /^(packages|apps)\/([^/]+)\//.exec(file);
  if (!m) continue;
  // Only source gates a release. A README or a test edit does not need one.
  if (!/^(packages|apps)\/[^/]+\/src\//.test(file)) continue;
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(file)) continue;
  try {
    const manifest = JSON.parse(readFileSync(`${m[1]}/${m[2]}/package.json`, 'utf8'));
    if (!manifest.private) published.add(manifest.name);
  } catch {
    // package.json gone in this range, nothing to gate on
  }
}

if (published.size === 0) {
  console.log('no published package source changed');
  process.exit(0);
}

if (changed.some((f) => /^\.changeset\/.+\.md$/.test(f))) {
  console.log(`changeset present for: ${[...published].join(', ')}`);
  process.exit(0);
}

console.error('These published packages changed with no changeset:');
for (const name of published) console.error(`  ${name}`);
console.error('\nRun `pnpm changeset` and commit the file, or the change will not be released.');
process.exit(1);
