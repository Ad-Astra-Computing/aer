import { describe, it, expect } from 'vitest';
import { buildLaunchdAgent } from './launchd-agent.js';

const BASE = { execPath: '/usr/local/bin/node', scriptPath: '/opt/aer/dist/main.js' };

describe('buildLaunchdAgent', () => {
  it('produces well-formed plist XML with the program arguments', () => {
    const { plist } = buildLaunchdAgent({ ...BASE, codexHome: { kind: 'unset' } });
    expect(plist).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(plist).toContain('<string>/usr/local/bin/node</string>');
    expect(plist).toContain('<string>sentinel-local</string>');
    expect(plist).not.toContain('EnvironmentVariables');
  });

  it('sets KeepAlive to SuccessfulExit:false, not a bare true (blocking 2)', () => {
    // A bare `true` relaunches on ANY exit, including the daemon's own
    // clean exit(0) on a 401/403 halt (runDaemonForever) - that crash-loops
    // forever, each loop making one more unauthenticated push attempt.
    // systemd's Restart=on-failure already gets this right; launchd needs
    // the equivalent dict form.
    const { plist } = buildLaunchdAgent({ ...BASE, codexHome: { kind: 'unset' } });
    expect(plist).toContain('<key>KeepAlive</key>');
    expect(plist).toContain('<key>SuccessfulExit</key>');
    expect(plist).toContain('<false/>');
    // Never the bare boolean form that restarts unconditionally.
    expect(plist).not.toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
  });

  it('writes EnvironmentVariables via the real serializer, escaping XML-unsafe characters', () => {
    const { plist, recordedCodexHome } = buildLaunchdAgent({
      ...BASE,
      codexHome: { kind: 'absolute', value: '/home/dev/<alt>&"codex"' },
    });
    expect(plist).toContain('<key>CODEX_HOME</key>');
    expect(plist).toContain('&lt;alt&gt;&amp;"codex"');
    expect(plist).not.toContain('<alt>&"codex"'); // never raw-concatenated
    expect(recordedCodexHome).toEqual({ kind: 'absolute', value: '/home/dev/<alt>&"codex"' });
  });

  it('never fails to escape a value (unlike systemd, there is no quote restriction)', () => {
    const { recordedCodexHome } = buildLaunchdAgent({
      ...BASE,
      codexHome: { kind: 'absolute', value: '/home/dev/"quoted"' },
    });
    expect(recordedCodexHome.kind).toBe('absolute');
  });
});
