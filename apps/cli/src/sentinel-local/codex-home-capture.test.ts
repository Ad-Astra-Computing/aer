import { describe, it, expect } from 'vitest';
import {
  captureCodexHome,
  escapeForSystemdEnvironmentLine,
  systemdCodexHomeEnvironmentLine,
  CodexHomeUnsafeError,
} from './codex-home-capture.js';

describe('captureCodexHome', () => {
  it('reports unset when the installing shell never set it', () => {
    expect(captureCodexHome({})).toEqual({ kind: 'unset' });
  });

  it('reports absolute for a well-formed absolute path', () => {
    expect(captureCodexHome({ CODEX_HOME: '/home/dev/.codex-alt' })).toEqual({
      kind: 'absolute',
      value: '/home/dev/.codex-alt',
    });
  });

  it('reports not_checkable for a relative path, never a guess', () => {
    const result = captureCodexHome({ CODEX_HOME: '.codex-alt' });
    expect(result.kind).toBe('not_checkable');
  });

  it('throws for a value containing a control character', () => {
    expect(() => captureCodexHome({ CODEX_HOME: '/home/dev/\nEnvironment=EVIL=1' })).toThrow(CodexHomeUnsafeError);
  });

  it('throws for a value containing a newline', () => {
    expect(() => captureCodexHome({ CODEX_HOME: '/a\nb' })).toThrow(CodexHomeUnsafeError);
  });
});

describe('escapeForSystemdEnvironmentLine', () => {
  it('doubles every literal percent sign', () => {
    expect(escapeForSystemdEnvironmentLine('/home/dev/100%-codex')).toBe('/home/dev/100%%-codex');
  });

  it('refuses a value containing a double quote', () => {
    expect(escapeForSystemdEnvironmentLine('/home/dev/"evil"')).toBeUndefined();
  });

  it('passes through a value with no special characters', () => {
    expect(escapeForSystemdEnvironmentLine('/home/dev/.codex-alt')).toBe('/home/dev/.codex-alt');
  });
});

describe('systemdCodexHomeEnvironmentLine', () => {
  it('produces a double-quoted Environment= line', () => {
    expect(systemdCodexHomeEnvironmentLine('/home/dev/.codex-alt')).toBe(
      'Environment="CODEX_HOME=/home/dev/.codex-alt"',
    );
  });

  it('returns undefined (never a fragile escape attempt) for a quote-containing value', () => {
    expect(systemdCodexHomeEnvironmentLine('/home/dev/"x"')).toBeUndefined();
  });
});
