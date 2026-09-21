// What the installer must write for a record to cover a whole run.
//
// Neither the SessionEnd timeout nor the lifecycle stamp is obvious from the
// code, and a run records nothing without either.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { install, configPathFor } from './install.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'aer-install-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

interface Entry { type: string; command: string; timeout?: number }
interface Group { matcher?: string; hooks: Entry[] }

function hooksOf(harness: 'claude-code' | 'codex'): Record<string, Group[]> {
  const raw = JSON.parse(readFileSync(configPathFor(harness, dir), 'utf8')) as Record<string, unknown>;
  return raw['hooks'] as Record<string, Group[]>;
}

function aerEntries(groups: Group[] | undefined): Entry[] {
  return (groups ?? []).flatMap((g) => g.hooks).filter((h) => h.command.includes('aer-hook') || h.command.includes('cli.js'));
}

describe.each(['claude-code', 'codex'] as const)('%s registration', (harness) => {
  it('registers the whole lifecycle, not just the turn boundary', async () => {
    await install(harness, { dir });
    const hooks = hooksOf(harness);
    for (const ev of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStart', 'SubagentStop', 'SessionEnd']) {
      expect(aerEntries(hooks[ev]), `${ev} not registered`).toHaveLength(1);
    }
  });

  it('stamps the lifecycle version on every command it writes', async () => {
    // Without this the binary cannot tell that SessionEnd is registered, and
    // would keep completing the record on every turn.
    await install(harness, { dir });
    const hooks = hooksOf(harness);
    const commands = Object.values(hooks).flatMap((g) => aerEntries(g)).map((h) => h.command);
    expect(commands.length).toBeGreaterThan(0);
    for (const c of commands) expect(c, c).toContain('--lifecycle v2');
  });
});

describe('the SessionEnd budget', () => {
  it('gives the Claude Code SessionEnd hook its own timeout', async () => {
    // Claude Code shares 1.5s across all SessionEnd hooks. Completion has to
    // reach the API, so the default budget would kill the one event that
    // turns a session into a signed record.
    await install('claude-code', { dir });
    const [entry] = aerEntries(hooksOf('claude-code')['SessionEnd']);
    expect(entry?.timeout).toBeGreaterThanOrEqual(10);
  });

  it('writes no timeout for Codex, which caps it anyway', async () => {
    // Codex caps SessionEnd at 3s whatever we ask for, and an unrecognised
    // key in its config is a risk we take nothing for.
    await install('codex', { dir });
    const [entry] = aerEntries(hooksOf('codex')['SessionEnd']);
    expect(entry).toBeDefined();
    expect(entry).not.toHaveProperty('timeout');
  });
});

describe('antigravity registration', () => {
  it('marks every invocation boundary', async () => {
    await install('antigravity', { dir });
    const raw = JSON.parse(readFileSync(configPathFor('antigravity', dir), 'utf8')) as Record<string, Record<string, Group[]>>;
    const group = raw['aer'] ?? {};
    for (const ev of ['PreToolUse', 'PostToolUse', 'PreInvocation', 'PostInvocation', 'Stop']) {
      expect(aerEntries(group[ev]), `${ev} not registered`).toHaveLength(1);
    }
  });
});

describe('upgrading an install that predates the lifecycle change', () => {
  it('rewrites our own entry instead of leaving the old command in place', async () => {
    // Idempotence was keyed on "an AER entry exists", so an upgraded user
    // kept the command an older release wrote and never moved to the new
    // lifecycle. Their records would keep splitting at every turn.
    const file = configPathFor('claude-code', dir);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'somebody-elses-hook.sh' }] },
          { matcher: '*', hooks: [{ type: 'command', command: 'aer-hook --harness claude-code' }] },
        ],
        Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'aer-hook --harness claude-code' }] }],
      },
    }));

    const r = await install('claude-code', { dir });
    expect(r.upgraded).toContain('PreToolUse');
    expect(r.upgraded).toContain('Stop');

    const hooks = hooksOf('claude-code');
    for (const c of aerEntries(hooks['PreToolUse']).map((h) => h.command)) {
      expect(c).toContain('--lifecycle v2');
    }
    // Somebody else's hook is untouched, and not duplicated.
    const others = (hooks['PreToolUse'] ?? []).flatMap((g) => g.hooks).filter((h) => h.command.includes('somebody-elses'));
    expect(others).toHaveLength(1);
  });

  it('adds the timeout an older entry was missing', async () => {
    const file = configPathFor('claude-code', dir);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({
      hooks: { SessionEnd: [{ matcher: '*', hooks: [{ type: 'command', command: 'aer-hook --harness claude-code' }] }] },
    }));
    await install('claude-code', { dir });
    const [entry] = aerEntries(hooksOf('claude-code')['SessionEnd']);
    expect(entry?.timeout).toBeGreaterThanOrEqual(10);
  });

  it('still changes nothing when the entry is already current', async () => {
    await install('claude-code', { dir });
    const before = readFileSync(configPathFor('claude-code', dir), 'utf8');
    const r = await install('claude-code', { dir });
    expect(r.added).toEqual([]);
    expect(r.upgraded).toEqual([]);
    expect(r.backupPath).toBeNull();
    expect(readFileSync(configPathFor('claude-code', dir), 'utf8')).toBe(before);
  });
});
