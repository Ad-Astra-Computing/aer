// ADR-023 B3: `aer-hooks status --json` surfaces stale registrations. Seeded
// with the settings file the 0.1.3 installer actually wrote (bare
// `aer-hook --harness claude-code`, no --lifecycle, registering only
// SessionStart/PreToolUse/PostToolUse/Stop), per the memory rule on testing
// the upgrade path rather than only a fresh install.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './install-cli.js';
import { configPathFor } from './install.js';

function write013Settings(dir: string): void {
  const file = configPathFor('claude-code', dir);
  mkdirSync(join(dir, '.claude'), { recursive: true });
  const command = 'aer-hook --harness claude-code';
  const group = (matcher = '*') => [{ matcher, hooks: [{ type: 'command', command }] }];
  writeFileSync(
    file,
    JSON.stringify({
      hooks: {
        SessionStart: group(),
        PreToolUse: group(),
        PostToolUse: group(),
        Stop: group(),
      },
    }),
  );
}

describe('aer-hooks status --json surfaces stale registrations', () => {
  it('flags a 0.1.3-era claude-code registration for missing --lifecycle v2', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aer-hooks-upgrade-'));
    try {
      write013Settings(dir);
      const lines: string[] = [];
      const code = await run(['status', '--dir', dir, '--json'], (s) => lines.push(s));
      expect(code).toBe(0);
      const report = JSON.parse(lines.join('\n')) as {
        hooks: { stale_registrations: Array<{ harness: string; reason: string; fix: string }> };
      };
      const reasons = report.hooks.stale_registrations.map((f) => f.reason);
      expect(reasons).toContain('missing_lifecycle_v2');
      // Only the command-shape finding; a real machine may ALSO report a
      // nix-profile shadow or an outdated version, which carry their own fix.
      for (const f of report.hooks.stale_registrations) {
        if (f.reason === 'missing_lifecycle_v2') expect(f.fix).toContain('aer-hooks install');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is clean after a fresh install brings the registration up to date', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aer-hooks-upgrade-'));
    try {
      write013Settings(dir);
      await run(['install', 'claude-code', '--dir', dir], () => {});
      const command = readFileSync(configPathFor('claude-code', dir), 'utf8');
      expect(command).toContain('--lifecycle v2');

      const lines: string[] = [];
      await run(['status', '--dir', dir, '--json'], (s) => lines.push(s));
      const report = JSON.parse(lines.join('\n')) as { hooks: { stale_registrations: unknown[] } };
      const commandReasons = report.hooks.stale_registrations as Array<{ reason: string }>;
      expect(commandReasons.some((f) => f.reason === 'missing_lifecycle_v2')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
