import { describe, it, expect } from 'vitest';
import { buildSystemdUnit, escapeSystemdExecArg, SystemdExecArgUnsafeError } from './systemd-unit.js';

const BASE = { execPath: '/usr/bin/node', scriptPath: '/opt/aer/dist/main.js' };

describe('buildSystemdUnit', () => {
  it('writes an absolute execPath/scriptPath ExecStart line', () => {
    const { unit } = buildSystemdUnit({ ...BASE, codexHome: { kind: 'unset' } });
    expect(unit).toContain('ExecStart=/usr/bin/node /opt/aer/dist/main.js sentinel-local run-daemon');
  });

  // B5: ExecStart= has its own argument-splitting grammar - a path with a
  // space already breaks the plain string-concatenated version, and a
  // literal newline could inject a second directive.
  it('quotes an execPath containing a space', () => {
    const { unit } = buildSystemdUnit({ execPath: '/opt/my app/node', scriptPath: '/opt/aer/dist/main.js', codexHome: { kind: 'unset' } });
    expect(unit).toContain('ExecStart="/opt/my app/node" /opt/aer/dist/main.js sentinel-local run-daemon');
  });

  it('doubles a literal % in the script path (specifier expansion)', () => {
    const { unit } = buildSystemdUnit({ execPath: '/usr/bin/node', scriptPath: '/opt/100%/main.js', codexHome: { kind: 'unset' } });
    expect(unit).toContain('ExecStart=/usr/bin/node /opt/100%%/main.js sentinel-local run-daemon');
  });

  it('escapes a backslash in a path', () => {
    const { unit } = buildSystemdUnit({ execPath: '/usr/bin/node', scriptPath: '/opt/aer\\dist/main.js', codexHome: { kind: 'unset' } });
    expect(unit).toContain('ExecStart=/usr/bin/node "/opt/aer\\\\dist/main.js" sentinel-local run-daemon');
  });

  it('escapes a double-quote character in a path', () => {
    const { unit } = buildSystemdUnit({ execPath: '/usr/bin/node', scriptPath: '/opt/"evil"/main.js', codexHome: { kind: 'unset' } });
    expect(unit).toContain('ExecStart=/usr/bin/node "/opt/\\"evil\\"/main.js" sentinel-local run-daemon');
  });

  it('refuses a path containing a raw newline rather than mis-escaping it', () => {
    expect(() => buildSystemdUnit({ execPath: '/usr/bin/node', scriptPath: '/opt/aer/\nmain.js', codexHome: { kind: 'unset' } })).toThrow(
      SystemdExecArgUnsafeError,
    );
  });
});

describe('escapeSystemdExecArg', () => {
  it('leaves a plain path unquoted', () => {
    expect(escapeSystemdExecArg('/usr/bin/node')).toBe('/usr/bin/node');
  });

  it('quotes an argument containing whitespace', () => {
    expect(escapeSystemdExecArg('/opt/my app/node')).toBe('"/opt/my app/node"');
  });

  it('doubles every literal %', () => {
    expect(escapeSystemdExecArg('/opt/100%-codex')).toBe('/opt/100%%-codex');
  });

  // B5 follow-up: ExecStart= also undergoes systemd's own $VAR/${VAR}
  // environment-variable expansion, independent of %-specifier expansion.
  // A literal `$` must round-trip as a literal `$`, not get substituted
  // or silently erased if the referenced variable is unset.
  it('doubles every literal $', () => {
    expect(escapeSystemdExecArg('/opt/a$b/node')).toBe('/opt/a$$b/node');
  });

  it('doubles every literal $ in a ${...}-shaped substring', () => {
    expect(escapeSystemdExecArg('/opt/${HOME}/node')).toBe('/opt/$${HOME}/node');
  });

  it('escapes backslash and double-quote inside a quoted argument', () => {
    expect(escapeSystemdExecArg('/opt/a\\b"c')).toBe('"/opt/a\\\\b\\"c"');
  });

  it('rejects a NUL byte', () => {
    expect(() => escapeSystemdExecArg('/opt/\0evil')).toThrow(SystemdExecArgUnsafeError);
  });

  it('rejects a raw newline', () => {
    expect(() => escapeSystemdExecArg('/opt/\nevil')).toThrow(SystemdExecArgUnsafeError);
  });

  it('writes no Environment= line when CODEX_HOME was unset', () => {
    const { unit, recordedCodexHome } = buildSystemdUnit({ ...BASE, codexHome: { kind: 'unset' } });
    expect(unit).not.toContain('Environment=');
    expect(recordedCodexHome).toEqual({ kind: 'unset' });
  });

  it('writes a double-quoted, %-doubled Environment= line for an absolute value', () => {
    const { unit, recordedCodexHome } = buildSystemdUnit({
      ...BASE,
      codexHome: { kind: 'absolute', value: '/home/dev/100%-codex' },
    });
    expect(unit).toContain('Environment="CODEX_HOME=/home/dev/100%%-codex"');
    expect(recordedCodexHome).toEqual({ kind: 'absolute', value: '/home/dev/100%-codex' });
  });

  it('downgrades to not_checkable rather than writing a half-escaped quote value', () => {
    const { unit, recordedCodexHome } = buildSystemdUnit({
      ...BASE,
      codexHome: { kind: 'absolute', value: '/home/dev/"evil"' },
    });
    expect(unit).not.toContain('Environment=');
    expect(recordedCodexHome.kind).toBe('not_checkable');
  });

  it('passes through an already not_checkable capture unchanged', () => {
    const codexHome = { kind: 'not_checkable' as const, reason: 'relative' };
    const { recordedCodexHome } = buildSystemdUnit({ ...BASE, codexHome });
    expect(recordedCodexHome).toEqual(codexHome);
  });
});
