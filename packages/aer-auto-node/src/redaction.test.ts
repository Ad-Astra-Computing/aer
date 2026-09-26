import { describe, it, expect } from 'vitest';
import { safeHost, redactArgs } from './redaction.js';

describe('safeHost', () => {
  it('keeps a host name, an IP and a port', () => {
    expect(safeHost('api.openai.com')).toBe('api.openai.com');
    expect(safeHost('127.0.0.1:8443')).toBe('127.0.0.1:8443');
    expect(safeHost('[::1]:80')).toBe('[::1]:80');
  });
  it('refuses anything carrying a path, userinfo, a query or whitespace', () => {
    for (const bad of ['x.test/secret', 'u:pw@x.test', 'x.test?t=1', 'x.test#f', 'x test', '', undefined, 7]) {
      expect(safeHost(bad)).toBe('unknown');
    }
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
