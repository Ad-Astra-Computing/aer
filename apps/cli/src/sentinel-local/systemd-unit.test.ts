import { describe, it, expect } from 'vitest';
import { buildSystemdUnit } from './systemd-unit.js';

const BASE = { execPath: '/usr/bin/node', scriptPath: '/opt/aer/dist/main.js' };

describe('buildSystemdUnit', () => {
  it('writes an absolute execPath/scriptPath ExecStart line', () => {
    const { unit } = buildSystemdUnit({ ...BASE, codexHome: { kind: 'unset' } });
    expect(unit).toContain('ExecStart=/usr/bin/node /opt/aer/dist/main.js sentinel-local run-daemon');
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
