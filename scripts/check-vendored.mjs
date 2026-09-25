#!/usr/bin/env node
// Logic that must be identical in more than one published package, without
// becoming a runtime dependency: the collector ships with none. So the file
// is copied, and this fails the build the moment a copy drifts.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** source -> every copy that must match it byte for byte. */
const VENDORED = new Map([
  [
    'shared/bodies-off/shell-reduce.ts',
    [
      'packages/aer-auto-node/src/shared/shell-reduce.ts',
      'apps/cli/src/shared/shell-reduce.ts',
      'packages/aer-hooks/src/shared/shell-reduce.ts',
    ],
  ],
  [
    'shared/bodies-off/ingest-allowlist.ts',
    [
      'packages/aer-hooks/src/shared/ingest-allowlist.ts',
      'packages/aer-mcp-recorder/src/shared/ingest-allowlist.ts',
    ],
  ],
  [
    'shared/bodies-off/claude-code-usage.ts',
    [
      'apps/cli/src/shared/claude-code-usage.ts',
      'packages/aer-hooks/src/shared/claude-code-usage.ts',
    ],
  ],
]);

const sha = (path) => createHash('sha256').update(readFileSync(join(root, path))).digest('hex');

let failed = false;
for (const [source, copies] of VENDORED) {
  let want;
  try {
    want = sha(source);
  } catch (err) {
    console.error(`missing vendored source: ${source} (${err.code ?? err.message})`);
    failed = true;
    continue;
  }
  for (const copy of copies) {
    let got;
    try {
      got = sha(copy);
    } catch (err) {
      console.error(`missing vendored copy: ${copy} (${err.code ?? err.message})`);
      failed = true;
      continue;
    }
    if (got === want) {
      console.log(`ok  ${relative(root, copy)}`);
      continue;
    }
    console.error(
      `DRIFT ${copy}\n  expected ${want} (from ${source})\n  actual   ${got}\n` +
        `  fix: cp ${source} ${copy}`,
    );
    failed = true;
  }
}

if (failed) {
  console.error('\nVendored copies are out of sync with their source.');
  process.exit(1);
}
