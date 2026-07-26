import { it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isInvokedDirectly } from './invoked-directly.js';

const savedArgv1 = process.argv[1];
afterEach(() => {
  process.argv[1] = savedArgv1;
});

it('returns true when argv[1] is a node_modules/.bin symlink to the module (the real bug)', () => {
  // Reproduces exactly how npm invokes a published bin: argv[1] is the .bin
  // symlink, import.meta.url is the realpath of the dist file. The old
  // string-equality guards returned false here, making every bin a no-op.
  const dir = mkdtempSync(join(tmpdir(), 'aer-bin-'));
  const real = join(dir, 'cli.js');
  writeFileSync(real, '// compiled entry');
  const binDir = join(dir, '.bin');
  mkdirSync(binDir);
  const link = join(binDir, 'aer-hook');
  symlinkSync(real, link);

  process.argv[1] = link;
  expect(isInvokedDirectly(pathToFileURL(real).href)).toBe(true);
});

it('returns true when argv[1] is the module file itself (node dist/cli.js)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aer-bin-'));
  const real = join(dir, 'cli.js');
  writeFileSync(real, '// compiled entry');
  process.argv[1] = real;
  expect(isInvokedDirectly(pathToFileURL(real).href)).toBe(true);
});

it('returns false when imported (argv[1] is a different program, e.g. a test runner)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aer-bin-'));
  const real = join(dir, 'cli.js');
  writeFileSync(real, '// compiled entry');
  const other = join(dir, 'vitest-runner.js');
  writeFileSync(other, '// runner');
  process.argv[1] = other;
  expect(isInvokedDirectly(pathToFileURL(real).href)).toBe(false);
});

it('returns false (fails closed) when argv[1] is unset', () => {
  // @ts-expect-error deliberately clearing for the test
  process.argv[1] = undefined;
  expect(isInvokedDirectly(pathToFileURL(join(tmpdir(), 'nope.js')).href)).toBe(false);
});
