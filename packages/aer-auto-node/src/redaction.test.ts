import { describe, it, expect } from 'vitest';
import { redactUrlPath, redactArgs, redactPathString } from './redaction.js';

describe('redactUrlPath', () => {
  it('keeps the path and drops the query string', () => {
    expect(redactUrlPath(new URL('https://x.test/v1/users?token=secret&id=7'))).toBe('/v1/users?<redacted>');
  });
  it('returns just the path when there is no query', () => {
    expect(redactUrlPath(new URL('https://x.test/v1/users'))).toBe('/v1/users');
  });
  it('redacts but signals the presence of a fragment-free query', () => {
    expect(redactUrlPath(new URL('https://x.test/?a=1'))).toBe('/?<redacted>');
  });
});

describe('redactPathString', () => {
  it('keeps the path and drops the query', () => {
    expect(redactPathString('/v1/x?token=secret')).toBe('/v1/x?<redacted>');
  });
  it('passes through a query-less path', () => {
    expect(redactPathString('/v1/x')).toBe('/v1/x');
  });
  it('defaults empty to root', () => {
    expect(redactPathString('')).toBe('/');
  });
});

describe('redactArgs', () => {
  it('replaces argument values with a count, not the values', () => {
    expect(redactArgs(['--token', 'abc', 'positional'])).toBe('<3 args redacted>');
  });
  it('handles no args', () => {
    expect(redactArgs([])).toBe('<0 args redacted>');
  });
});
