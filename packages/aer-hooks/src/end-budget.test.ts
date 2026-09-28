// The time a harness allows a session end, declared on the command the
// installer writes. With it, the hook delivers inline for that long, so a
// record completes even where a background worker cannot outlive the
// harness (a container or CI step that ends with it). Without it, the hook
// keeps to Claude Code's default 1.5 s and leaves the rest to the worker.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { install } from './install.js';
import { staleRegistrations } from './hooks-doctor.js';
import { runHook, main, parseEndBudgetMs, endBudgetWindowMs } from './cli.js';
import { FakeApi } from './fake-api.test-support.js';
import { loadState } from './session-store.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aer-end-budget-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function commands(file: string): Record<string, string> {
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  const out: Record<string, string> = {};
  const hooks = (cfg['hooks'] ?? cfg['aer']) as Record<string, unknown>;
  for (const [ev, v] of Object.entries(hooks)) {
    if (!Array.isArray(v)) continue;
    const first = v[0] as { command?: string; hooks?: Array<{ command: string }> };
    out[ev] = first.command ?? first.hooks![0]!.command;
  }
  return out;
}

describe('the installer declares the session end budget it registered', () => {
  it('Claude Code: SessionEnd carries a budget inside its 15 s timeout; no other event does', async () => {
    await install('claude-code', { dir });
    const cmds = commands(path.join(dir, '.claude', 'settings.json'));
    expect(cmds['SessionEnd']).toContain('--end-budget-ms 13500');
    for (const [ev, c] of Object.entries(cmds)) if (ev !== 'SessionEnd') expect(c, ev).not.toContain('--end-budget-ms');
  });

  it('Codex: SessionEnd carries a budget inside the 3 s Codex allows', async () => {
    await install('codex', { dir });
    expect(commands(path.join(dir, '.codex', 'hooks.json'))['SessionEnd']).toContain('--end-budget-ms 2500');
  });

  it('Antigravity: its session end is Stop, which carries a budget inside the 30 s default', async () => {
    await install('antigravity', { dir });
    const cmds = commands(path.join(dir, '.gemini', 'config', 'hooks.json'));
    expect(cmds['Stop']).toContain('--end-budget-ms 25000');
    expect(cmds['PreToolUse']).not.toContain('--end-budget-ms');
  });
});

describe('parseEndBudgetMs', () => {
  it('reads a positive whole number and ignores anything else', () => {
    expect(parseEndBudgetMs(['--end-budget-ms', '13500'])).toBe(13500);
    expect(parseEndBudgetMs(['--end-budget-ms=2500'])).toBe(2500);
    for (const bad of ['0', '-5', 'abc', '1.5', '']) expect(parseEndBudgetMs(['--end-budget-ms', bad])).toBeUndefined();
    expect(parseEndBudgetMs([])).toBeUndefined();
  });
});

describe('a session end with a declared budget', () => {
  it('delivers inline for that budget, so the record completes even if the worker never runs', async () => {
    const api = new FakeApi();
    const env = {
      AER_API_KEY: 'k', AER_TENANT_ID: 't', AER_AGENT_ID: 'a', AER_ENV_ID: '01950000-0000-7000-8000-0000000000ad',
      AER_BASE_URL: 'http://aer.test', XDG_CACHE_HOME: path.join(dir, 'cache'), TMPDIR: dir, HOME: dir,
    } as NodeJS.ProcessEnv;
    const argv = ['--harness', 'claude-code', '--lifecycle', 'v2'];
    const lead = { session_id: 'cc-budget', cwd: dir };
    await runHook(argv, env, { readInput: async () => JSON.stringify({ ...lead, hook_event_name: 'SessionStart' }), fetch: api.fetch });
    api.openDelayMs = 0;
    api.eventsDelayMs = 1500;
    api.completeDelayMs = 1500;
    const started = Date.now();
    await runHook([...argv, '--end-budget-ms', '8000'], env, {
      readInput: async () => JSON.stringify({ ...lead, hook_event_name: 'SessionEnd', reason: 'other' }),
      fetch: api.fetch,
      // A worker that starts and then dies with its container.
      handOff: () => true,
      processStart: started,
    });
    expect(api.completes()).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(8000);
  }, 20_000);
});

describe('the declared budget sets how long a session end may run', () => {
  it('is honoured past the hook timeout, and clamped to 30 s', () => {
    expect(endBudgetWindowMs(['--end-budget-ms', '13500'])).toBe(13500);
    expect(endBudgetWindowMs(['--end-budget-ms', '9999999'])).toBe(30_000);
    expect(endBudgetWindowMs([])).toBeUndefined();
  });

  it('keeps a 13.5 s session end sending after 10 s, the default hook timeout', async () => {
    const api = new FakeApi();
    const env = {
      AER_API_KEY: 'k', AER_TENANT_ID: 't', AER_AGENT_ID: 'a', AER_ENV_ID: '01950000-0000-7000-8000-0000000000ad',
      AER_BASE_URL: 'http://aer.test', XDG_CACHE_HOME: path.join(dir, 'cache'), TMPDIR: dir, HOME: dir,
    } as NodeJS.ProcessEnv;
    const argv = ['--harness', 'claude-code', '--lifecycle', 'v2'];
    const lead = { session_id: 'cc-long-end', cwd: dir };
    await runHook(argv, env, { readInput: async () => JSON.stringify({ ...lead, hook_event_name: 'SessionStart' }), fetch: api.fetch });
    // Sending the closing report and completing take 11 s together.
    api.eventsDelayMs = 6000;
    api.completeDelayMs = 5000;
    const started = Date.now();
    await main([...argv, '--end-budget-ms', '13500'], env, {
      readInput: async () => JSON.stringify({ ...lead, hook_event_name: 'SessionEnd', reason: 'other' }),
      fetch: api.fetch,
      handOff: () => true,
      processStart: started,
    });
    expect(api.completes()).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(13_500);
    // The fake API counts a request when it arrives, so the complete above
    // could be one the hook sent and then abandoned. Only a hook still
    // running past 10 s gets the answer and records the session as ended.
    const st = loadState('cc-long-end', env)!;
    expect(st.complete).toBeUndefined();
    expect(st.ended).toBe(true);
  }, 30_000);
});

describe('an install from the last release', () => {
  // What 0.5.1 wrote: no end budget on any entry.
  function seed(): void {
    const claude: Record<string, unknown> = {};
    for (const ev of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStart', 'SubagentStop', 'SessionEnd']) {
      const h: Record<string, unknown> = { type: 'command', command: 'aer-hook --harness claude-code --lifecycle v2' };
      if (ev === 'SessionEnd' || ev === 'SessionStart') h['timeout'] = 15;
      claude[ev] = [{ matcher: '*', hooks: [h] }];
    }
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ hooks: claude }));
    const codex: Record<string, unknown> = {};
    for (const ev of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStart', 'SubagentStop', 'SessionEnd']) {
      codex[ev] = [{ matcher: '*', hooks: [{ type: 'command', command: 'aer-hook --harness codex --lifecycle v2' }] }];
    }
    fs.mkdirSync(path.join(dir, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.codex', 'hooks.json'), JSON.stringify({ hooks: codex }));
    const agy: Record<string, unknown> = { enabled: true };
    for (const ev of ['PreToolUse', 'PostToolUse', 'PreInvocation', 'PostInvocation', 'Stop']) {
      agy[ev] = [{ command: `aer-hook --harness antigravity --lifecycle v2 --event ${ev}`, ...(ev.endsWith('ToolUse') ? { matcher: '*' } : {}) }];
    }
    fs.mkdirSync(path.join(dir, '.gemini', 'config'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.gemini', 'config', 'hooks.json'), JSON.stringify({ aer: agy }));
  }

  it('is flagged by status for its session end entries, and install brings each up to date', async () => {
    seed();
    const before = (await staleRegistrations({ dir })).filter((f) => f.reason === 'no_end_budget');
    expect(before.map((f) => f.harness).sort()).toEqual(['antigravity', 'claude-code', 'codex']);
    for (const f of before) expect(f.fix).toBe(`aer-hooks install ${f.harness}`);
    for (const h of ['claude-code', 'codex', 'antigravity'] as const) await install(h, { dir });
    expect(commands(path.join(dir, '.claude', 'settings.json'))['SessionEnd']).toContain('--end-budget-ms 13500');
    expect(commands(path.join(dir, '.codex', 'hooks.json'))['SessionEnd']).toContain('--end-budget-ms 2500');
    expect(commands(path.join(dir, '.gemini', 'config', 'hooks.json'))['Stop']).toContain('--end-budget-ms 25000');
    expect((await staleRegistrations({ dir })).filter((f) => f.reason === 'no_end_budget')).toEqual([]);
  });
});

describe('status for Antigravity', () => {
  it('runs the per-command checks on its entries too', async () => {
    const agy: Record<string, unknown> = { enabled: true };
    for (const ev of ['PreToolUse', 'PostToolUse', 'PreInvocation', 'PostInvocation', 'Stop']) {
      // As written before lifecycle v2 existed.
      agy[ev] = [{ command: `aer-hook --harness antigravity --event ${ev}` }];
    }
    fs.mkdirSync(path.join(dir, '.gemini', 'config'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.gemini', 'config', 'hooks.json'), JSON.stringify({ aer: agy }));
    const findings = await staleRegistrations({ dir });
    expect(findings.some((f) => f.harness === 'antigravity' && f.reason === 'missing_lifecycle_v2')).toBe(true);
  });
});
