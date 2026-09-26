import { describe, it, expect } from 'vitest';
import {
  diagnoseCommand,
  diagnoseRegistrations,
  diagnoseVersion,
  diagnoseNixShadow,
  isOlderVersion,
  MIN_HOOKS_VERSION_FOR_B1,
} from './doctor.js';
import type { StatusEntry } from './install.js';

describe('diagnoseCommand', () => {
  it('flags a command with no --lifecycle v2', () => {
    const findings = diagnoseCommand('claude-code', '/x/aer-hook --harness claude-code');
    expect(findings.map((f) => f.reason)).toContain('missing_lifecycle_v2');
    expect(findings.find((f) => f.reason === 'missing_lifecycle_v2')?.fix).toBe('aer-hooks install claude-code');
  });

  it('accepts --lifecycle=v2 (the parser-accepted equals form), not only the spaced form', () => {
    const findings = diagnoseCommand('claude-code', 'aer-hook --harness claude-code --lifecycle=v2');
    expect(findings).toEqual([]);
  });

  it('a fully current claude-code command is clean', () => {
    const findings = diagnoseCommand('claude-code', 'aer-hook --harness claude-code --lifecycle v2');
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
  });

  it('is clean for a fully current registration', () => {
    const findings = diagnoseRegistrations([
      entry({ commands: ['aer-hook --harness claude-code --lifecycle v2'] }),
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
    const f = diagnoseVersion('0.1.3', '0.5.0');
    expect(f?.reason).toBe('outdated_collector');
  });

  it('is clean when installed matches current', () => {
    expect(diagnoseVersion('0.5.0', '0.5.0')).toBeUndefined();
  });

  it('is clean when the version could not be determined', () => {
    expect(diagnoseVersion(undefined, '0.5.0')).toBeUndefined();
    expect(diagnoseVersion('unknown', '0.5.0')).toBeUndefined();
  });

  it('says "wired" by default, since most callers have a harness config', () => {
    const f = diagnoseVersion('0.1.3', '0.5.0');
    expect(f?.detail).toContain('wired');
  });

  it('says "on PATH" instead of "wired" when no harness config references it', () => {
    const f = diagnoseVersion('0.1.3', '0.5.0', { wired: false });
    expect(f?.detail).toContain('on PATH');
    expect(f?.detail).not.toContain('wired');
  });

  it('reports an unreadable version distinctly from a real stale one, and still suggests the upgrade', () => {
    const f = diagnoseVersion('unreadable', '0.5.0');
    expect(f?.reason).toBe('outdated_collector');
    expect(f?.detail).toContain('could not read the version');
    expect(f?.detail).not.toContain('0.0.0');
    expect(f?.fix).toContain('aer-hooks install');
  });

  it('says "on PATH" for an unreadable version too, when nothing wires it', () => {
    const f = diagnoseVersion('unreadable', '0.5.0', { wired: false });
    expect(f?.detail).toContain('on PATH');
    expect(f?.detail).not.toContain('wired');
  });

  // Review P2: a "current" version below the pinned B1 floor (e.g. read
  // wrong through a consumer's bundle) must not make an installed release
  // that predates B1 look clean.
  it('clamps to the pinned B1 floor when the caller-supplied current version reads lower', () => {
    const f = diagnoseVersion('0.3.0', '0.2.0');
    expect(f?.reason).toBe('outdated_collector');
    expect(f?.detail).toContain(MIN_HOOKS_VERSION_FOR_B1);
  });

  it('never flags an installed release at or above the floor just because "current" reads low', () => {
    expect(diagnoseVersion(MIN_HOOKS_VERSION_FOR_B1, '0.2.0')).toBeUndefined();
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

  // Review P2 (the actual VM false positive): a nix-profile aer-hook with NO
  // project install nearby is a legitimate, working setup of its own, not a
  // shadow of anything - it must never warn.
  it('is clean when there is no project install for the nix copy to shadow', () => {
    const dirs = ['/home/user/.nix-profile/bin'];
    const hasAerHook = (dir: string): boolean => dirs.includes(dir);
    expect(diagnoseNixShadow(dirs, hasAerHook, '/home/user/project/node_modules/.bin')).toBeUndefined();
  });
});
