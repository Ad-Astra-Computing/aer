// Runs the changeset gate against throwaway git repos, the way CI runs it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const gate = resolve(import.meta.dirname, '../.github/scripts/check-changeset.mjs');

function repoWith(change) {
  const dir = mkdtempSync(join(tmpdir(), 'gate-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(dir, 'packages/pkg/src'), { recursive: true });
  writeFileSync(join(dir, 'packages/pkg/package.json'), '{"name":"@scope/pkg","version":"1.0.0"}\n');
  writeFileSync(join(dir, 'packages/pkg/src/version.generated.ts'), 'export const V = "1.0.0";\n');
  writeFileSync(join(dir, 'packages/pkg/src/index.ts'), 'export {};\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  change(dir);
  git('add', '-A');
  git('commit', '-q', '-m', 'head');
  const head = git('rev-parse', 'HEAD');
  const r = spawnSync(process.execPath, [gate], { cwd: dir, env: { ...process.env, BASE_SHA: base, HEAD_SHA: head }, encoding: 'utf8' });
  rmSync(dir, { recursive: true, force: true });
  return r.status;
}

test('a regenerated version file alone needs no changeset', () => {
  const status = repoWith((dir) => {
    writeFileSync(join(dir, 'packages/pkg/package.json'), '{"name":"@scope/pkg","version":"1.1.0"}\n');
    writeFileSync(join(dir, 'packages/pkg/src/version.generated.ts'), 'export const V = "1.1.0";\n');
  });
  assert.equal(status, 0);
});

test('a source change without a changeset still fails', () => {
  const status = repoWith((dir) => {
    writeFileSync(join(dir, 'packages/pkg/src/index.ts'), 'export const x = 1;\n');
  });
  assert.equal(status, 1);
});

test('a version file beside a real source change still fails', () => {
  const status = repoWith((dir) => {
    writeFileSync(join(dir, 'packages/pkg/src/version.generated.ts'), 'export const V = "1.1.0";\n');
    writeFileSync(join(dir, 'packages/pkg/src/index.ts'), 'export const x = 1;\n');
  });
  assert.equal(status, 1);
});
