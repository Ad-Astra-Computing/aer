import { describe, it, expect } from 'vitest';
import {
  diagnoseCommand,
  diagnoseRegistrations,
  diagnoseVersion,
  diagnoseNixShadow,
  isOlderVersion,
} from './doctor.js';
import type { StatusEntry } from './install.js';

describe('diagnoseCommand', () => {
  it('flags a command with no --lifecycle v2', () => {
    const findings = diagnoseCommand('claude-code', '/x/aer-hook --harness claude-code --root-session "${CLAUDE_SESSION_ID}"');
    expect(findings.map((f) => f.reason)).toContain('missing_lifecycle_v2');
    expect(findings.find((f) => f.reason === 'missing_lifecycle_v2')?.fix).toBe('aer-hooks install claude-code');
  });

  it('flags a claude-code command with no --root-session', () => {
    const findings = diagnoseCommand('claude-code', 'aer-hook --harness claude-code --lifecycle v2');
    expect(findings.map((f) => f.reason)).toContain('missing_root_session');
  });

  it('a codex command is never flagged for missing --root-session', () => {
    const findings = diagnoseCommand('codex', 'aer-hook --harness codex --lifecycle v2');
    expect(findings.map((f) => f.reason)).not.toContain('missing_root_session');
  });

  it('a fully current claude-code command is clean', () => {
    const findings = diagnoseCommand('claude-code', 'aer-hook --harness claude-code --lifecycle v2 --root-session "${CLAUDE_SESSION_ID}"');
    expect(findings).toEqual([]);
  });
});

function entry(overrides: Partial<StatusEntry>): StatusEntry {
  return { harness: 'claude-code', path: '/x', exists: true, wiredEvents: ['PreToolUse'], resolves: true, commands: [], ...overrides };
}

describe('diagnoseRegistrations', () => {
  it('is empty for nothing wired', () => {
    expect(diagnoseRegistrations([entry({ wiredEvents: [], commands: [] })])).toEqual([]);
  });

  it('surfaces one finding per stale reason, deduplicated across commands', () => {
    const findings = diagnoseRegistrations([
      entry({ commands: ['aer-hook --harness claude-code', 'aer-hook --harness claude-code'] }),
    ]);
    expect(findings.filter((f) => f.reason === 'missing_lifecycle_v2')).toHaveLength(1);
    expect(findings.filter((f) => f.reason === 'missing_root_session')).toHaveLength(1);
  });

  it('is clean for a fully current registration', () => {
    const findings = diagnoseRegistrations([
      entry({ commands: ['aer-hook --harness claude-code --lifecycle v2 --root-session "${CLAUDE_SESSION_ID}"'] }),
    ]);
    expect(findings).toEqual([]);
  });
});

describe('isOlderVersion', () => {
  it('compares dotted numeric versions', () => {
    expect(isOlderVersion('0.1.3', '0.3.0')).toBe(true);
    expect(isOlderVersion('0.3.0', '0.3.0')).toBe(false);
    expect(isOlderVersion('0.3.1', '0.3.0')).toBe(false);
    expect(isOlderVersion('1.0.0', '0.9.9')).toBe(false);
  });
});

describe('diagnoseVersion', () => {
  it('flags an installed release older than current', () => {
    const f = diagnoseVersion('0.1.3', '0.3.0');
    expect(f?.reason).toBe('outdated_collector');
  });

  it('is clean when installed matches current', () => {
    expect(diagnoseVersion('0.3.0', '0.3.0')).toBeUndefined();
  });

  it('is clean when the version could not be determined', () => {
    expect(diagnoseVersion(undefined, '0.3.0')).toBeUndefined();
    expect(diagnoseVersion('unknown', '0.3.0')).toBeUndefined();
  });
});

describe('diagnoseNixShadow', () => {
  it('flags an aer-hook resolved from a nix profile ahead of the project install', () => {
    const dirs = ['/home/user/.nix-profile/bin', '/home/user/project/node_modules/.bin'];
    const hasAerHook = (dir: string): boolean => dirs.includes(dir);
    const f = diagnoseNixShadow(dirs, hasAerHook, '/home/user/project/node_modules/.bin');
    expect(f?.reason).toBe('nix_profile_shadow');
  });

  it('is clean when the project install wins PATH precedence', () => {
    const dirs = ['/home/user/project/node_modules/.bin', '/home/user/.nix-profile/bin'];
    const hasAerHook = (dir: string): boolean => dirs.includes(dir);
    expect(diagnoseNixShadow(dirs, hasAerHook, '/home/user/project/node_modules/.bin')).toBeUndefined();
  });

  it('is clean when no aer-hook is on PATH at all', () => {
    expect(diagnoseNixShadow(['/usr/bin'], () => false, undefined)).toBeUndefined();
  });

  it('is clean for a non-nix global install', () => {
    const dirs = ['/usr/local/bin'];
    expect(diagnoseNixShadow(dirs, () => true, undefined)).toBeUndefined();
  });
});
