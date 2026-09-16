import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { install, uninstall, status, configPathFor, AER_HOOK_MARKER, hookCommandResolves } from './install.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aer-hooks-test-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

function ccPath() {
  return configPathFor('claude-code', dir);
}
function codexPath() {
  return configPathFor('codex', dir);
}

describe('install (claude-code)', () => {
  it('creates a fresh settings file with all four events wired', async () => {
    const r = await install('claude-code', { dir });
    expect(r.added.sort()).toEqual(['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop']);
    expect(r.backupPath).toBeNull(); // no prior file to back up
    const cfg = await readJson(ccPath());
    const hooks = cfg['hooks'] as Record<string, unknown[]>;
    for (const ev of ['PreToolUse', 'PostToolUse', 'SessionStart', 'Stop']) {
      const groups = hooks[ev] as Array<{ hooks: Array<{ command: string }> }>;
      expect(groups[0]!.hooks[0]!.command).toContain(AER_HOOK_MARKER);
      expect(groups[0]!.hooks[0]!.command).toContain('claude-code');
    }
  });

  it('preserves existing unrelated hooks and top-level keys', async () => {
    await fs.mkdir(path.dirname(ccPath()), { recursive: true });
    await fs.writeFile(
      ccPath(),
      JSON.stringify({
        model: 'claude-sonnet-5',
        hooks: {
          PreToolUse: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/local/bin/my-guard.sh' }] },
          ],
        },
      }),
    );
    const r = await install('claude-code', { dir });
    expect(r.backupPath).toBe(`${ccPath()}.bak`);
    const cfg = await readJson(ccPath());
    // unrelated top-level key preserved
    expect(cfg['model']).toBe('claude-sonnet-5');
    const pre = (cfg['hooks'] as Record<string, unknown[]>)['PreToolUse'] as Array<{
      hooks: Array<{ command: string }>;
    }>;
    // the user's guard is still there, plus AER's new group
    const commands = pre.flatMap((g) => g.hooks.map((h) => h.command));
    expect(commands).toContain('/usr/local/bin/my-guard.sh');
    expect(commands.some((c) => c.includes(AER_HOOK_MARKER))).toBe(true);
  });

  it('is idempotent: re-running adds no duplicate entries', async () => {
    await install('claude-code', { dir });
    const first = await readJson(ccPath());
    const r2 = await install('claude-code', { dir });
    expect(r2.added).toEqual([]);
    expect(r2.alreadyPresent.sort()).toEqual([
      'PostToolUse',
      'PreToolUse',
      'SessionStart',
      'Stop',
    ]);
    const second = await readJson(ccPath());
    expect(second).toEqual(first);
    // exactly one AER command per event
    const hooks = second['hooks'] as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    for (const ev of Object.keys(hooks)) {
      const aerCount = hooks[ev]!.flatMap((g) => g.hooks)
        .filter((h) => h.command.includes(AER_HOOK_MARKER)).length;
      expect(aerCount).toBe(1);
    }
  });

  it('writes a backup of the prior file before modifying', async () => {
    await fs.mkdir(path.dirname(ccPath()), { recursive: true });
    const prior = JSON.stringify({ hooks: { Stop: [] }, other: true });
    await fs.writeFile(ccPath(), prior);
    await install('claude-code', { dir });
    const backup = await fs.readFile(`${ccPath()}.bak`, 'utf8');
    expect(backup).toBe(prior);
  });

  it('aborts on malformed existing JSON without clobbering it', async () => {
    await fs.mkdir(path.dirname(ccPath()), { recursive: true });
    const garbage = '{ this is not: valid json ]]';
    await fs.writeFile(ccPath(), garbage);
    await expect(install('claude-code', { dir })).rejects.toThrow(/malformed/i);
    // original file untouched, no backup or overwrite happened
    expect(await fs.readFile(ccPath(), 'utf8')).toBe(garbage);
    await expect(fs.access(`${ccPath()}.bak`)).rejects.toBeTruthy();
  });
});

describe('install resolves a runnable hook command', () => {
  const savedPath = process.env['PATH'];
  afterEach(() => { process.env['PATH'] = savedPath; });

  it('classifies a bare command by PATH and a node-path command by the file', () => {
    // A bare `aer-hook` resolves only if it is on PATH; a `node <abs>` command
    // resolves if that file exists. The installer prefers whichever will run.
    process.env['PATH'] = '/nonexistent-path-dir';
    expect(hookCommandResolves('aer-hook --harness claude-code')).toBe(false);
    const here = new URL('.', import.meta.url).pathname;
    expect(hookCommandResolves(`node ${JSON.stringify(here + 'install.ts')} --harness claude-code`)).toBe(true);
    expect(hookCommandResolves(`node ${JSON.stringify(here + 'no-such.js')} --harness claude-code`)).toBe(false);
  });

  it('status reports a wired command that cannot be found', async () => {
    process.env['PATH'] = '/nonexistent-path-dir';
    await install('claude-code', { dir });
    // Rewrite the wired command to a binary that is not there, as a stale
    // install to a removed location would leave it.
    const file = ccPath();
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
    const hooks = raw['hooks'] as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    for (const ev of Object.keys(hooks)) {
      for (const g of hooks[ev]!) for (const h of g.hooks) h.command = 'aer-hook --harness claude-code';
    }
    await fs.writeFile(file, JSON.stringify(raw));
    const st = await status({ dir });
    const cc = st.find((e) => e.harness === 'claude-code')!;
    expect(cc.wiredEvents.length).toBeGreaterThan(0);
    expect(cc.resolves).toBe(false);
  });
});

describe('hook command resolution details (Fable review)', () => {
  const savedPath = process.env['PATH'];
  afterEach(() => { process.env['PATH'] = savedPath; });

  it('does not trust an aer-hook found only in an ephemeral node_modules/.bin', async () => {
    // Under npx the installer's PATH carries node_modules/.bin, which the
    // harness never has. A name found only there must not be written bare.
    const binDir = path.join(dir, 'node_modules', '.bin');
    mkdirSync(binDir, { recursive: true });
    const fake = path.join(binDir, 'aer-hook');
    writeFileSync(fake, '#!/bin/sh\n'); chmodSync(fake, 0o755);
    process.env['PATH'] = binDir;
    // The pinned form runs against the built dist, so build layout aside, the
    // resolver must treat the ephemeral dir as not counting.
    expect(hookCommandResolves('aer-hook --harness claude-code')).toBe(false);
  });

  it('counts an aer-hook on a persistent PATH dir', async () => {
    const binDir = path.join(dir, 'bin');
    mkdirSync(binDir, { recursive: true });
    const real = path.join(binDir, 'aer-hook');
    writeFileSync(real, '#!/bin/sh\n'); chmodSync(real, 0o755);
    process.env['PATH'] = binDir;
    expect(hookCommandResolves('aer-hook --harness claude-code')).toBe(true);
  });

  it('does not count a name that is present but not executable', async () => {
    const binDir = path.join(dir, 'bin2');
    mkdirSync(binDir, { recursive: true });
    const notExec = path.join(binDir, 'aer-hook');
    writeFileSync(notExec, 'x'); chmodSync(notExec, 0o644);
    process.env['PATH'] = binDir;
    expect(hookCommandResolves('aer-hook --harness claude-code')).toBe(false);
  });

  it('does not misread a foreign cli.js hook as ours', async () => {
    // A user's own hook running a different cli.js must survive uninstall and
    // must not block install as already present.
    const file = ccPath();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'node /opt/other/cli.js --harness codex' }] }] },
    }));
    const r = await install('claude-code', { dir });
    expect(r.added).toContain('PreToolUse');
    const after = JSON.parse(await fs.readFile(file, 'utf8')) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    const commands = after.hooks['PreToolUse']!.flatMap((g) => g.hooks.map((h) => h.command));
    expect(commands).toContain('node /opt/other/cli.js --harness codex');
    await uninstall('claude-code', { dir });
    const final = JSON.parse(await fs.readFile(file, 'utf8')) as { hooks?: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    const left = (final.hooks?.['PreToolUse'] ?? []).flatMap((g) => g.hooks.map((h) => h.command));
    expect(left).toContain('node /opt/other/cli.js --harness codex');
  });

  it('does not throw on a hand-written unquoted node command', () => {
    expect(() => hookCommandResolves('node /no/such/cli.js --harness codex')).not.toThrow();
    expect(hookCommandResolves('node /no/such/cli.js --harness codex')).toBe(false);
  });
});

describe('install (codex)', () => {
  it('writes to ~/.codex/hooks.json with codex harness command', async () => {
    await install('codex', { dir });
    const cfg = await readJson(codexPath());
    const hooks = cfg['hooks'] as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    expect(hooks['PreToolUse']![0]!.hooks[0]!.command).toContain('--harness codex');
  });
});

describe('uninstall', () => {
  it('removes only AER entries and leaves other hooks intact', async () => {
    await fs.mkdir(path.dirname(ccPath()), { recursive: true });
    await fs.writeFile(
      ccPath(),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/local/bin/my-guard.sh' }] },
          ],
        },
      }),
    );
    await install('claude-code', { dir });
    const r = await uninstall('claude-code', { dir });
    expect(r.removed.sort()).toEqual(['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop']);
    const cfg = await readJson(ccPath());
    const hooks = cfg['hooks'] as Record<string, unknown[]>;
    // the user's guard survives; AER-only events are gone
    const pre = hooks['PreToolUse'] as Array<{ hooks: Array<{ command: string }> }>;
    const commands = pre.flatMap((g) => g.hooks.map((h) => h.command));
    expect(commands).toContain('/usr/local/bin/my-guard.sh');
    expect(commands.some((c) => c.includes(AER_HOOK_MARKER))).toBe(false);
    // events that were AER-only were removed entirely
    expect(hooks['SessionStart']).toBeUndefined();
    expect(hooks['Stop']).toBeUndefined();
  });

  it('no-ops when nothing is installed', async () => {
    await install('claude-code', { dir });
    await uninstall('claude-code', { dir });
    const r = await uninstall('claude-code', { dir });
    expect(r.removed).toEqual([]);
  });

  it('aborts on malformed JSON rather than clobber', async () => {
    await fs.mkdir(path.dirname(ccPath()), { recursive: true });
    await fs.writeFile(ccPath(), 'nope');
    await expect(uninstall('claude-code', { dir })).rejects.toThrow(/malformed/i);
  });
});

describe('status', () => {
  it('reports no config before install and wired events after', async () => {
    const before = await status({ dir });
    const cc = before.find((e) => e.harness === 'claude-code')!;
    expect(cc.exists).toBe(false);
    expect(cc.wiredEvents).toEqual([]);

    await install('claude-code', { dir });
    const after = await status({ dir });
    const cc2 = after.find((e) => e.harness === 'claude-code')!;
    expect(cc2.exists).toBe(true);
    expect(cc2.wiredEvents.sort()).toEqual(['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop']);
  });

  it('reports config present but no AER hooks for an unrelated config', async () => {
    await fs.mkdir(path.dirname(codexPath()), { recursive: true });
    await fs.writeFile(codexPath(), JSON.stringify({ hooks: { PreToolUse: [] } }));
    const s = await status({ dir });
    const codex = s.find((e) => e.harness === 'codex')!;
    expect(codex.exists).toBe(true);
    expect(codex.wiredEvents).toEqual([]);
  });
});

describe('install safety hardening', () => {
  it('refuses to write through a symlinked config file', async () => {
    const cc = ccPath();
    await fs.mkdir(path.dirname(cc), { recursive: true });
    const elsewhere = path.join(dir, 'elsewhere.json');
    await fs.writeFile(elsewhere, '{}');
    await fs.symlink(elsewhere, cc);
    await expect(install('claude-code', { dir })).rejects.toThrow(/symlink/);
    // The symlink target was not modified.
    expect(await fs.readFile(elsewhere, 'utf8')).toBe('{}');
  });

  it('leaves an unrelated user hook whose command merely mentions aer-hook', async () => {
    const cc = ccPath();
    await fs.mkdir(path.dirname(cc), { recursive: true });
    // A user hook that is NOT ours but contains the substring.
    await fs.writeFile(cc, JSON.stringify({
      hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'my-aer-hook-wrapper --x' }] }] },
    }));
    await install('claude-code', { dir });
    await uninstall('claude-code', { dir });
    const after = await readJson(cc);
    const pre = (after['hooks'] as Record<string, unknown>)['PreToolUse'] as Array<{ hooks: Array<{ command: string }> }>;
    // The user's unrelated command survives uninstall; only the exact AER entry was removed.
    const cmds = pre.flatMap((g) => g.hooks.map((h) => h.command));
    expect(cmds).toContain('my-aer-hook-wrapper --x');
    expect(cmds).not.toContain(`${AER_HOOK_MARKER} --harness claude-code`);
  });

  it('preserves the existing config file mode on rewrite', async () => {
    const cc = ccPath();
    await fs.mkdir(path.dirname(cc), { recursive: true });
    await fs.writeFile(cc, '{}', { mode: 0o644 });
    await fs.chmod(cc, 0o644);
    await install('claude-code', { dir });
    const mode = (await fs.stat(cc)).mode & 0o777;
    expect(mode).toBe(0o644);
  });
});
