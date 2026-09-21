import { describe, it, expect } from 'vitest';
import { esmEntryOf } from './esm-entry.js';

describe('esmEntryOf', () => {
  it('reads a conditional exports map', () => {
    expect(esmEntryOf({ exports: { '.': { import: './index.mjs', require: './index.js' } } }))
      .toBe('./index.mjs');
  });

  it('reads a nested condition', () => {
    expect(esmEntryOf({ exports: { '.': { import: { types: './i.d.ts', default: './index.mjs' } } } }))
      .toBe('./index.mjs');
  });

  it('falls back to the module field', () => {
    expect(esmEntryOf({ module: './dist/index.mjs', main: './dist/index.js' })).toBe('./dist/index.mjs');
  });

  it('uses main when the package is already ESM', () => {
    expect(esmEntryOf({ type: 'module', main: './index.js' })).toBe('./index.js');
  });

  it('returns nothing for a CJS-only package', () => {
    expect(esmEntryOf({ main: './index.js' })).toBeUndefined();
    expect(esmEntryOf({ exports: { '.': { require: './index.js' } } })).toBeUndefined();
  });

  it('is not fooled by a non-string entry', () => {
    expect(esmEntryOf({ exports: { '.': { import: 42 } } })).toBeUndefined();
    expect(esmEntryOf({ module: ['./a.mjs'] })).toBeUndefined();
    expect(esmEntryOf(null)).toBeUndefined();
    expect(esmEntryOf('nonsense')).toBeUndefined();
  });

  it('refuses an entry that escapes the package', () => {
    // The path is joined onto a package directory and imported. A traversal
    // would load something outside the package we resolved.
    expect(esmEntryOf({ module: '../../../etc/passwd' })).toBeUndefined();
    expect(esmEntryOf({ exports: { '.': { import: '/abs/path.mjs' } } })).toBeUndefined();
  });
});
