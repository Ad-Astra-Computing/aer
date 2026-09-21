#!/usr/bin/env node
// Re-fetch each vendored third-party schema and report drift.
//
// The conformance suite validates what AER writes into someone else's tool
// against that tool's published schema. A vendored copy is only as good as
// the day it was fetched, so this is the canary: it runs on a schedule, and a
// difference means the harness surface moved and the claim needs rechecking.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const SCHEMAS = [
  {
    file: 'packages/conformance/src/schemas/claude-code-settings.schema.json',
    url: 'https://www.schemastore.org/claude-code-settings.json',
  },
];

const canon = (text) => JSON.stringify(JSON.parse(text));
const sha = (text) => createHash('sha256').update(text).digest('hex');

let drifted = false;
for (const { file, url } of SCHEMAS) {
  const local = canon(readFileSync(join(root, file), 'utf8'));
  let remote;
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    remote = canon(await res.text());
  } catch (err) {
    console.error(`could not fetch ${url}: ${err.message}`);
    process.exitCode = 1;
    continue;
  }
  if (sha(local) === sha(remote)) {
    console.log(`ok     ${file}`);
    continue;
  }
  console.error(
    `DRIFT  ${file}\n  the published schema at ${url} has changed.\n` +
      `  Re-fetch it, then run the conformance suite: what AER writes may no\n` +
      `  longer be what the harness accepts.`,
  );
  drifted = true;
}

if (drifted) process.exitCode = 1;
