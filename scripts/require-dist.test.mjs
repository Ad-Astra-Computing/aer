import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const script = join(import.meta.dirname, 'require-dist.mjs');

// Every file gets an explicit mtime, so a file written by the test itself can
// never be the newest input by accident.
function tree(files) {
  const dir = mkdtempSync(join(tmpdir(), 'aer-require-dist-'));
  for (const [path, [mtime, body = '']] of Object.entries(files)) {
    const file = join(dir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
    utimesSync(file, mtime, mtime);
  }
  return dir;
}

function run(cwd) {
  const r = spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' });
  return { code: r.status, err: r.stderr };
}

const manifest = (extra = {}) => [50, { name: 'p', ...extra }];

test('passes when dist is newer than every source file', () => {
  assert.equal(run(tree({ 'package.json': manifest(), 'src/a.ts': [100], 'dist/a.js': [200] })).code, 0);
});

test('fails when dist is missing', () => {
  const r = run(tree({ 'package.json': manifest(), 'src/a.ts': [100] }));
  assert.equal(r.code, 1);
  assert.match(r.err, /dist is missing/);
});

test('fails when a source file changed after the build, and names it', () => {
  const r = run(tree({ 'package.json': manifest(), 'src/a.ts': [100], 'src/b.ts': [300], 'dist/a.js': [200] }));
  assert.equal(r.code, 1);
  assert.match(r.err, /dist is stale/);
  assert.match(r.err, /src[/\\]b\.ts/);
});

test('ignores tests, which never ship', () => {
  const dir = tree({ 'package.json': manifest(), 'src/a.ts': [100], 'src/a.test.ts': [300], 'dist/a.js': [200] });
  assert.equal(run(dir).code, 0);
});

test('reads nested source directories', () => {
  const dir = tree({ 'package.json': manifest(), 'src/deep/b.ts': [300], 'dist/a.js': [200] });
  assert.equal(run(dir).code, 1);
});

test('counts build inputs at the package root, such as tsconfig.json', () => {
  const r = run(tree({ 'package.json': manifest(), 'tsconfig.json': [300], 'src/a.ts': [100], 'dist/a.js': [200] }));
  assert.equal(r.code, 1);
  assert.match(r.err, /tsconfig\.json/);
});

function workspace(depSrcMtime) {
  return tree({
    'pnpm-workspace.yaml': [50, "packages:\n  - 'packages/*'\n"],
    'packages/dep/package.json': [50, { name: 'dep' }],
    'packages/dep/src/d.ts': [depSrcMtime],
    'packages/dep/dist/d.js': [150],
    'packages/app/package.json': [50, { name: 'app', devDependencies: { dep: 'workspace:*' } }],
    'packages/app/src/a.ts': [100],
    'packages/app/dist/a.js': [200],
  });
}

test('counts the sources of workspace dependencies, which a bundle inlines', () => {
  assert.equal(run(join(workspace(120), 'packages', 'app')).code, 0);
  const r = run(join(workspace(300), 'packages', 'app'));
  assert.equal(r.code, 1);
  assert.match(r.err, /dep[/\\]src[/\\]d\.ts/);
});

test('fails loudly on a workspace dependency it cannot find', () => {
  const dir = tree({
    'pnpm-workspace.yaml': [50, "packages:\n  - 'packages/*'\n"],
    'packages/app/package.json': [50, { name: 'app', dependencies: { gone: 'workspace:*' } }],
    'packages/app/src/a.ts': [100],
    'packages/app/dist/a.js': [200],
  });
  const r = run(join(dir, 'packages', 'app'));
  assert.equal(r.code, 1);
  assert.match(r.err, /gone/);
});

test('fails when a runtime dependency has a stale dist of its own', () => {
  // The dependent's dist is newest of all, so only checking the dependency's
  // own build catches that it still loads yesterday's code.
  const dir = tree({
    'pnpm-workspace.yaml': [50, "packages:\n  - 'packages/*'\n"],
    'packages/dep/package.json': [50, { name: 'dep', exports: { '.': './dist/d.js' } }],
    'packages/dep/src/d.ts': [160],
    'packages/dep/dist/d.js': [150],
    'packages/app/package.json': [50, { name: 'app', dependencies: { dep: 'workspace:*' } }],
    'packages/app/src/a.ts': [100],
    'packages/app/dist/a.js': [200],
  });
  const r = run(join(dir, 'packages', 'app'));
  assert.equal(r.code, 1);
  assert.match(r.err, /^dep: dist is stale: src[/\\]d\.ts/);
});

test('fails loudly when the workspace file has no packages list', () => {
  const dir = tree({
    'pnpm-workspace.yaml': [50, 'allowBuilds:\n  esbuild: true\n'],
    'packages/app/package.json': [50, { name: 'app' }],
    'packages/app/src/a.ts': [100],
    'packages/app/dist/a.js': [200],
  });
  const r = run(join(dir, 'packages', 'app'));
  assert.equal(r.code, 1);
  assert.match(r.err, /packages/);
});

test('reads past comments and blank lines inside the packages list', () => {
  const dir = tree({
    'pnpm-workspace.yaml': [50, "packages:\n  # libraries\n  - 'packages/*'\n\n  - apps/tool\n"],
    'apps/tool/package.json': [50, { name: 'tool' }],
    'apps/tool/src/t.ts': [100],
    'packages/app/package.json': [50, { name: 'app', devDependencies: { tool: 'workspace:*' } }],
    'packages/app/src/a.ts': [100],
    'packages/app/dist/a.js': [200],
  });
  assert.equal(run(join(dir, 'packages', 'app')).code, 0);
});

test('does not count documentation at the package root as a build input', () => {
  const dir = tree({
    'package.json': manifest(), 'README.md': [300], 'LICENSE': [300], 'src/a.ts': [100], 'dist/a.js': [200],
  });
  assert.equal(run(dir).code, 0);
});

test('does not demand a dist from a dependency consumed from its sources', () => {
  // A private helper whose exports point at src has no dist to be stale, even
  // when it has a typecheck-only build script.
  const dir = tree({
    'pnpm-workspace.yaml': [50, "packages:\n  - 'packages/*'\n"],
    'packages/helper/package.json': [50, { name: 'helper', exports: { '.': './src/h.ts' }, scripts: { build: 'tsc' } }],
    'packages/helper/src/h.ts': [100],
    'packages/app/package.json': [50, { name: 'app', devDependencies: { helper: 'workspace:*' } }],
    'packages/app/src/a.ts': [100],
    'packages/app/dist/a.js': [200],
  });
  assert.equal(run(join(dir, 'packages', 'app')).code, 0);
});
