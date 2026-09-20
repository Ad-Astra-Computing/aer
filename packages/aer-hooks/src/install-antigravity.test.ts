/**
 * Antigravity's hooks.json is shaped differently from the other two harnesses:
 * the root is a map of NAMED hook groups, each holding its own event map, with
 * no `hooks` wrapper key. Writing the Claude Code shape into it registers
 * nothing, silently, so the layout is per-harness and covered here.
 *
 * Format verified against antigravity.google/docs/hooks.
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

    expect(r.added).toEqual(['PreToolUse', 'PostToolUse', 'PreInvocation', 'Stop']);
    const config = await readConfig();
    const group = config['aer'] as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    expect(Object.keys(group).sort()).toEqual(['PostToolUse', 'PreInvocation', 'PreToolUse', 'Stop']);
    for (const ev of Object.keys(group)) {
      const cmd = group[ev]![0]!.hooks[0]!.command;
      expect(cmd).toBe(`aer-hook --harness antigravity --event ${ev}`);
    }
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

describe('status reports antigravity alongside the other harnesses', () => {
  it('lists it as unconfigured before install and wired after', async () => {
    const before = (await status({ dir })).find((e) => e.harness === 'antigravity');
    expect(before).toBeDefined();
    expect(before!.exists).toBe(false);

    await install('antigravity', { dir });

    const after = (await status({ dir })).find((e) => e.harness === 'antigravity')!;
    expect(after.exists).toBe(true);
    expect(after.wiredEvents.sort()).toEqual(['PostToolUse', 'PreInvocation', 'PreToolUse', 'Stop']);
  });
});
