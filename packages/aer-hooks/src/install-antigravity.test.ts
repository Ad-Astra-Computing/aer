/**
 * Antigravity's hooks.json is shaped differently from the other two harnesses
 * at BOTH levels: the root is a map of named hook groups with no `hooks`
 * wrapper, and inside an event the command sits directly on the entry rather
 * than in a nested `hooks` array of typed objects.
 *
 * Getting the inner level wrong is not ignored, it is rejected: the CLI logs
 * `invalid hook "aer": command hook must specify 'command'` and loads none of
 * the group. Shape confirmed by running the CLI, not only by reading the docs.
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
    for (const ev of Object.keys(group)) {
      if (ev === 'enabled') continue;
      const entry = (group[ev] as Array<Record<string, unknown>>)[0]!;
      expect(entry['command']).toBe(`aer-hook --harness antigravity --lifecycle v2 --event ${ev}`);
      // The nested typed-object form is what the CLI rejects outright.
      expect(entry).not.toHaveProperty('hooks');
      expect(entry).not.toHaveProperty('type');
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
