import { describe, it, expect } from 'vitest';
import { resolvePrincipal } from './principal.js';

describe('resolvePrincipal', () => {
  it('defaults kind to user when absent or invalid', () => {
    expect(resolvePrincipal('e1', undefined, undefined)).toEqual({ id: 'e1', kind: 'user' });
    expect(resolvePrincipal('e1', 'root', undefined)).toEqual({ id: 'e1', kind: 'user' });
  });

  it('keeps a valid kind', () => {
    expect(resolvePrincipal('e1', 'service', undefined)).toEqual({ id: 'e1', kind: 'service' });
    expect(resolvePrincipal('e1', 'ci', undefined)).toEqual({ id: 'e1', kind: 'ci' });
  });

  it('includes a display within the cap', () => {
    expect(resolvePrincipal('e1', 'user', 'Grace H.')).toEqual({
      id: 'e1',
      kind: 'user',
      display: 'Grace H.',
    });
  });

  it('returns undefined without an id or with an oversized id', () => {
    expect(resolvePrincipal(undefined, 'user', undefined)).toBeUndefined();
    expect(resolvePrincipal('', 'user', undefined)).toBeUndefined();
    expect(resolvePrincipal('a'.repeat(129), 'user', undefined)).toBeUndefined();
  });

  it('accepts an id at the 128 cap', () => {
    expect(resolvePrincipal('a'.repeat(128), 'user', undefined)).toEqual({
      id: 'a'.repeat(128),
      kind: 'user',
    });
  });

  it('drops an oversized display but keeps the principal', () => {
    expect(resolvePrincipal('e1', 'ci', 'd'.repeat(65))).toEqual({ id: 'e1', kind: 'ci' });
  });
});
