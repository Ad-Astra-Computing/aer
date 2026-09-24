import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = join(import.meta.dirname, 'require-dist.mjs');

function pkg({ src = {}, dist = {} }) {
  const dir = mkdtempSync(join(tmpdir(), 'aer-require-dist-'));
  for (const [tree, files] of [['src', src], ['dist', dist]]) {
    for (const [name, mtime] of Object.entries(files)) {
      mkdirSync(join(dir, tree), { recursive: true });
      const file = join(dir, tree, name);
      writeFileSync(file, '');
      utimesSync(file, mtime, mtime);
    }
  }
  return dir;
}

function run(cwd) {
  const r = spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' });
  return { code: r.status, err: r.stderr };
}

test('passes when dist is newer than every source file', () => {
  assert.equal(run(pkg({ src: { 'a.ts': 100 }, dist: { 'a.js': 200 } })).code, 0);
});

test('fails when dist is missing', () => {
  const r = run(pkg({ src: { 'a.ts': 100 } }));
  assert.equal(r.code, 1);
  assert.match(r.err, /dist is missing/);
});

test('fails when a source file changed after the build', () => {
  const r = run(pkg({ src: { 'a.ts': 100, 'b.ts': 300 }, dist: { 'a.js': 200 } }));
  assert.equal(r.code, 1);
  assert.match(r.err, /dist is stale/);
});

test('ignores tests, which never ship', () => {
  assert.equal(run(pkg({ src: { 'a.ts': 100, 'a.test.ts': 300 }, dist: { 'a.js': 200 } })).code, 0);
});

test('reads nested directories on both sides', () => {
  const r = run(pkg({ src: { 'a.ts': 100 }, dist: { 'a.js': 200 } }));
  assert.equal(r.code, 0);
  const nested = pkg({ dist: { 'a.js': 200 } });
  mkdirSync(join(nested, 'src', 'deep'), { recursive: true });
  writeFileSync(join(nested, 'src', 'deep', 'b.ts'), '');
  utimesSync(join(nested, 'src', 'deep', 'b.ts'), 300, 300);
  assert.equal(run(nested).code, 1);
});
