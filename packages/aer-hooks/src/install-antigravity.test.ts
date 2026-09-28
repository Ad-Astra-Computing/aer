/**
 * Antigravity's hooks.json is shaped differently from the other two harnesses.
 * The root is a map of named hook groups with no `hooks` wrapper, and inside
 * a group the two kinds of event take different entries:
 *
 *   - PreToolUse and PostToolUse are grouped: `{ matcher, hooks: [{ type,
 *     command }] }`, as in Claude Code.
 *   - PreInvocation, PostInvocation and Stop are flat: `{ command }` directly.
 *
 * Both ways of getting it wrong were seen against agy 1.2.6. The grouped form
 * on an invocation event is rejected, and the CLI logs `invalid hook "aer":
 * command hook must specify 'command'` and loads none of the group. The flat
 * form on a tool event loads without complaint and never fires, so a run
 * recorded its turns and not one of its tool calls.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { install, uninstall, status, configPathFor } from './install.js';

let dir: string;

const CONFIG = () => path.join(dir, '.gemini', 'config', 'hooks.json');

async function readConfig(): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(CONFIG(), 'utf8')) as Record<string, unknown>;
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aer-agy-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('install for antigravity', () => {
  it('writes to the documented global config path', () => {
    expect(configPathFor('antigravity', dir)).toBe(CONFIG());
  });

  it('registers every event under one named group, each passing its own event name', async () => {
    const r = await install('antigravity', { dir });

    expect(r.added).toEqual(['PreToolUse', 'PostToolUse', 'PreInvocation', 'PostInvocation', 'Stop']);
    const config = await readConfig();
    const group = config['aer'] as Record<string, unknown>;
    expect(Object.keys(group).filter((k) => k !== 'enabled').sort())
      .toEqual(['PostInvocation', 'PostToolUse', 'PreInvocation', 'PreToolUse', 'Stop']);
    for (const ev of ['PreInvocation', 'PostInvocation', 'Stop']) {
      const entry = (group[ev] as Array<Record<string, unknown>>)[0]!;
      // Stop ends an Antigravity session, so it also carries the time allowed for that.
      const budget = ev === 'Stop' ? ' --end-budget-ms 25000' : '';
      // Flat: the nested typed-object form is what the CLI rejects outright.
      expect(entry).toEqual({ command: `aer-hook --harness antigravity --lifecycle v2 --event ${ev}${budget}` });
    }
  });

  it('wraps the tool events in a matcher group, the only form agy fires them from', async () => {
    await install('antigravity', { dir });

    const group = (await readConfig())['aer'] as Record<string, unknown>;
    for (const ev of ['PreToolUse', 'PostToolUse']) {
      expect(group[ev]).toEqual([{
        matcher: '*',
        hooks: [{ type: 'command', command: `aer-hook --harness antigravity --lifecycle v2 --event ${ev}` }],
      }]);
    }
  });

  it('rewrites a flat tool-event registration an earlier release wrote', async () => {
    const flat = (ev: string) => ({ command: `aer-hook --harness antigravity --lifecycle v2 --event ${ev}` });
    await fs.mkdir(path.dirname(CONFIG()), { recursive: true });
    await fs.writeFile(CONFIG(), JSON.stringify({
      aer: {
        enabled: true,
        PreToolUse: [{ matcher: '*', ...flat('PreToolUse') }],
        PostToolUse: [{ matcher: '*', ...flat('PostToolUse') }],
        PreInvocation: [flat('PreInvocation')],
        PostInvocation: [flat('PostInvocation')],
        Stop: [flat('Stop')],
      },
    }));

    const r = await install('antigravity', { dir });

    expect(r.backupPath).not.toBeNull();
    const group = (await readConfig())['aer'] as Record<string, Array<Record<string, unknown>>>;
    expect(group['PreToolUse']![0]!['hooks']).toBeDefined();
    expect(group['PreToolUse']![0]).not.toHaveProperty('command');
    const st = (await status({ dir })).find((e) => e.harness === 'antigravity')!;
    expect(st.wiredEvents.sort()).toEqual(['PostInvocation', 'PostToolUse', 'PreInvocation', 'PreToolUse', 'Stop']);
  });

  it('does not wrap the group in a hooks key, which Antigravity would ignore', async () => {
    await install('antigravity', { dir });

    expect(await readConfig()).not.toHaveProperty('hooks');
  });

  it('sets a matcher only on the tool events, the only ones that accept one', async () => {
    await install('antigravity', { dir });

    const group = await readConfig().then((c) => c['aer'] as Record<string, Array<Record<string, unknown>>>);
    expect(group['PreToolUse']![0]!['matcher']).toBe('*');
    expect(group['PostToolUse']![0]!['matcher']).toBe('*');
    expect(group['PreInvocation']![0]).not.toHaveProperty('hooks');
    expect(group['PreInvocation']![0]).not.toHaveProperty('matcher');
    expect(group['Stop']![0]).not.toHaveProperty('matcher');
  });

  it('leaves another tool\'s hook groups untouched', async () => {
    await fs.mkdir(path.dirname(CONFIG()), { recursive: true });
    await fs.writeFile(
      CONFIG(),
      JSON.stringify({ 'my-linter': { PostToolUse: [{ matcher: 'run_command', hooks: [{ command: './lint.sh' }] }] } }),
    );

    await install('antigravity', { dir });

    const config = await readConfig();
    expect(config['my-linter']).toEqual({
      PostToolUse: [{ matcher: 'run_command', hooks: [{ command: './lint.sh' }] }],
    });
    expect(config['aer']).toBeDefined();
  });

  it('is idempotent and does not rewrite the file on a second run', async () => {
    await install('antigravity', { dir });
    const second = await install('antigravity', { dir });

    expect(second.added).toEqual([]);
    expect(second.backupPath).toBeNull();
  });

  it('refuses to clobber a malformed config', async () => {
    await fs.mkdir(path.dirname(CONFIG()), { recursive: true });
    await fs.writeFile(CONFIG(), '{ not json');

    await expect(install('antigravity', { dir })).rejects.toThrow(/malformed/);
    expect(await fs.readFile(CONFIG(), 'utf8')).toBe('{ not json');
  });
});

describe('uninstall for antigravity', () => {
  it('removes only AER\'s group', async () => {
    await fs.mkdir(path.dirname(CONFIG()), { recursive: true });
    await fs.writeFile(CONFIG(), JSON.stringify({ 'my-linter': { PostToolUse: [] } }));
    await install('antigravity', { dir });

    const r = await uninstall('antigravity', { dir });

    expect(r.removed.length).toBeGreaterThan(0);
    const config = await readConfig();
    expect(config).not.toHaveProperty('aer');
    expect(config).toHaveProperty('my-linter');
  });

  it('is a no-op when nothing is installed', async () => {
    const r = await uninstall('antigravity', { dir });
    expect(r.removed).toEqual([]);
    expect(r.backupPath).toBeNull();
  });
});

describe('status sees every antigravity command', () => {
  it('reports the flat invocation commands as well as the grouped tool ones', async () => {
    await install('antigravity', { dir });
    const st = (await status({ dir })).find((e) => e.harness === 'antigravity')!;
    for (const ev of ['PreToolUse', 'PreInvocation', 'Stop']) {
      expect(st.commands.some((c) => c.includes(`--event ${ev}`)), ev).toBe(true);
    }
  });
});

describe('status reports antigravity alongside the other harnesses', () => {
  it('lists it as unconfigured before install and wired after', async () => {
    const before = (await status({ dir })).find((e) => e.harness === 'antigravity');
    expect(before).toBeDefined();
    expect(before!.exists).toBe(false);

    await install('antigravity', { dir });

    const after = (await status({ dir })).find((e) => e.harness === 'antigravity')!;
    expect(after.exists).toBe(true);
    expect(after.wiredEvents.sort()).toEqual(['PostInvocation', 'PostToolUse', 'PreInvocation', 'PreToolUse', 'Stop']);
  });
});

describe('the shape the CLI actually accepts', () => {
  it('puts the command on the entry, not in a nested typed object', async () => {
    // Running the real CLI against the nested form logged
    // `invalid hook "aer": command hook must specify 'command'` and loaded
    // nothing, so this integration never recorded anything at all.
    await install('antigravity', { dir });
    const group = (await readConfig())['aer'] as Record<string, unknown>;
    const entry = (group['Stop'] as Array<Record<string, unknown>>)[0]!;
    expect(Object.keys(entry).sort()).toEqual(['command']);
  });

  it('marks the group enabled, as the schema expects', async () => {
    await install('antigravity', { dir });
    const group = (await readConfig())['aer'] as Record<string, unknown>;
    expect(group['enabled']).toBe(true);
  });
});
