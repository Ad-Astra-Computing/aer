// prepack guard: refuse to pack a dist that is missing or older than src.
// It only reads. changeset publish packs every package at once, so a prepack
// that rebuilt would rewrite a dist while another package's tests load it.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function newest(dir, skip = () => false) {
  let max = -Infinity;
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || skip(entry.name)) continue;
    max = Math.max(max, statSync(join(entry.parentPath, entry.name)).mtimeMs);
  }
  return max;
}

let built;
try {
  built = newest('dist');
} catch {
  built = -Infinity;
}
if (built === -Infinity) {
  console.error('dist is missing: run pnpm -r build first');
  process.exit(1);
}
if (newest('src', (name) => /\.test\.[cm]?[jt]s$/.test(name)) > built) {
  console.error('dist is stale: src changed after the last build, run pnpm -r build first');
  process.exit(1);
}
