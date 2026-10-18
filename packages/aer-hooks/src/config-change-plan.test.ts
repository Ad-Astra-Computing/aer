import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  computeConfigChangePlan, applyConfigChangePlan,
  computeConfigBaselinePlan, applyConfigBaselinePlan,
  stashConfigWriterOnToolStart, closeConfigWriterOnToolEnd,
  commandNamesConfigPath,
} from './config-change-plan.js';
import { freshState, type SessionState } from './session-store.js';
import type { HookEvent } from './normalize.js';

describe('config-change-plan', () => {
  let dir: string;
  const T = 1_000_000;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aer-config-plan-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function configChangeEvent(filePath: string, source = 'project_settings'): HookEvent {
    return { kind: 'config_change', configFilePath: filePath, configSource: source as HookEvent['configSource'] };
  }

  it('reads an absent file as config_status absent', () => {
    const missing = path.join(dir, 'nope.json');
    const plan = computeConfigChangePlan(configChangeEvent(missing), dir);
    expect(plan.kind).toBe('change');
    if (plan.kind === 'change') expect(plan.snapshot.config_status).toBe('absent');
  });

  it('reads a file over the size cap as too_large, without reading its bytes', () => {
    const big = path.join(dir, 'big.json');
    fs.writeFileSync(big, Buffer.alloc(1024 * 1024 + 1, 0x20));
    const plan = computeConfigChangePlan(configChangeEvent(big), dir);
    expect(plan.kind).toBe('change');
    if (plan.kind === 'change') {
      expect(plan.snapshot.config_status).toBe('too_large');
      expect(plan.bytes.length).toBe(0);
    }
  });

  it('refuses a symlink as unreadable rather than following it', () => {
    const real = path.join(dir, 'real.json');
    fs.writeFileSync(real, JSON.stringify({ permissions: { allow: ['Bash'] } }));
    const link = path.join(dir, 'link.json');
    fs.symlinkSync(real, link);
    const plan = computeConfigChangePlan(configChangeEvent(link), dir);
    expect(plan.kind).toBe('change');
    if (plan.kind === 'change') expect(plan.snapshot.config_status).toBe('unreadable');
  });

  it('parses a real file into an ok snapshot', () => {
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, JSON.stringify({ permissions: { allow: ['Bash'], deny: ['Bash(curl:*)'] } }));
    const plan = computeConfigChangePlan(configChangeEvent(file), dir);
    expect(plan.kind).toBe('change');
    if (plan.kind === 'change') {
      expect(plan.snapshot.config_status).toBe('ok');
      expect(plan.snapshot.allow_rules).toBe(1);
      expect(plan.snapshot.deny_rules).toBe(1);
    }
  });

  it('degrades malformed JSON to unparseable rather than throwing', () => {
    const file = path.join(dir, 'bad.json');
    fs.writeFileSync(file, '{ this is not json');
    expect(() => computeConfigChangePlan(configChangeEvent(file), dir)).not.toThrow();
    const plan = computeConfigChangePlan(configChangeEvent(file), dir);
    expect(plan.kind).toBe('change');
    if (plan.kind === 'change') expect(plan.snapshot.config_status).toBe('unparseable');
  });

  it('drops a no-op reload (same bytes) entirely: nothing to emit', () => {
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, JSON.stringify({ permissions: { allow: ['Bash'] } }));
    const event1: HookEvent = configChangeEvent(file);
    const state: SessionState = freshState(T);
    const plan1 = computeConfigChangePlan(event1, dir);
    applyConfigChangePlan(event1, state, plan1, T);
    expect(event1.configChangeShapes?.length).toBe(1);

    // Same bytes again (a touch, or a cp of identical content).
    const event2: HookEvent = configChangeEvent(file);
    const plan2 = computeConfigChangePlan(event2, dir);
    applyConfigChangePlan(event2, state, plan2, T + 1000);
    expect(event2.configChangeShapes).toBeUndefined();
  });

  it('emits a real change with the expected wire shape', () => {
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, JSON.stringify({ permissions: { allow: [] } }));
    const state: SessionState = freshState(T);
    const e1 = configChangeEvent(file);
    applyConfigChangePlan(e1, state, computeConfigChangePlan(e1, dir), T);

    fs.writeFileSync(file, JSON.stringify({ permissions: { allow: [], deny: [] } }));
    const e2 = configChangeEvent(file);
    applyConfigChangePlan(e2, state, computeConfigChangePlan(e2, dir), T + 1000);
    // deny array added but empty: no deny_rules count change, so content_only.
    const shape = e2.configChangeShapes?.[0];
    expect(shape?.eventType).toBe('config.changed');
    expect(shape?.payload['config_changes']).toEqual(['content_only']);
    expect(shape?.payload['writer']).toBe('none_observed');
    expect(Object.keys(shape?.payload ?? {}).sort()).toEqual(
      ['aer_hook_count', 'allow_rules', 'broad_allow_rules', 'config_changes', 'config_source', 'config_status', 'default_mode', 'deny_rules', 'hooks_disabled', 'trigger', 'writer'].sort(),
    );
  });

  it('attributes a write_tool stash to the matching ConfigChange', () => {
    const file = path.join(dir, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({}));
    const state: SessionState = freshState(T);
    stashConfigWriterOnToolStart(state, 'Edit', 'tu-1', [{ eventType: 'file.written', payload: { path: file } }], undefined, dir, undefined, T);

    fs.writeFileSync(file, JSON.stringify({ permissions: { allow: ['Bash'] } }));
    const event: HookEvent = configChangeEvent(file);
    applyConfigChangePlan(event, state, computeConfigChangePlan(event, dir), T + 500);
    expect(event.configChangeShapes?.[0]?.payload['writer']).toBe('write_tool');
  });

  it('never stashes a write to a path outside .claude', () => {
    const file = path.join(dir, 'README.md');
    fs.writeFileSync(file, 'hi');
    const state: SessionState = freshState(T);
    stashConfigWriterOnToolStart(state, 'Edit', 'tu-1', [{ eventType: 'file.written', payload: { path: file } }], undefined, dir, undefined, T);
    expect(state.configWriteToolStash).toBeUndefined();
  });

  it('attributes shell_named when the (discarded) command text mentions a settings path', () => {
    const file = path.join(dir, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({}));
    const state: SessionState = freshState(T);
    stashConfigWriterOnToolStart(state, 'Bash', 'tu-shell', [], undefined, dir, commandNamesConfigPath('sed -i "s/deny/allow/" .claude/settings.json'), T);
    closeConfigWriterOnToolEnd(state, 'Bash', 'tu-shell');

    fs.writeFileSync(file, JSON.stringify({ permissions: { allow: ['Bash'] } }));
    const event: HookEvent = configChangeEvent(file);
    applyConfigChangePlan(event, state, computeConfigChangePlan(event, dir), T + 500);
    expect(event.configChangeShapes?.[0]?.payload['writer']).toBe('shell_named');
  });

  it('commandNamesConfigPath never influences the emitted payload (only the boolean survives)', () => {
    expect(commandNamesConfigPath('cat .claude/settings.json')).toBe(true);
    expect(commandNamesConfigPath('ls -la')).toBe(false);
  });

  it('never throws given a malformed or huge settings file end to end, and never produces a decision-shaped payload', () => {
    const huge = path.join(dir, 'huge.json');
    fs.writeFileSync(huge, Buffer.alloc(2 * 1024 * 1024));
    const state: SessionState = freshState(T);
    const event = configChangeEvent(huge);
    expect(() => {
      const plan = computeConfigChangePlan(event, dir);
      applyConfigChangePlan(event, state, plan, T);
    }).not.toThrow();
    const wire = JSON.stringify(event.configChangeShapes ?? []);
    expect(wire).not.toContain('"decision"');
  });
});

describe('SessionStart baseline', () => {
  let home: string;
  let cwd: string;
  const T = 2_000_000;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'aer-baseline-home-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'aer-baseline-cwd-'));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('skips files that do not exist entirely', () => {
    const event: HookEvent = { kind: 'session_start', cwd };
    const plan = computeConfigBaselinePlan(event, cwd, home);
    expect(plan.length).toBe(0);
  });

  it('baselines only files that exist, up to the user/project/local set', () => {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash'] } }));
    fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.claude', 'settings.local.json'), JSON.stringify({}));

    const event: HookEvent = { kind: 'session_start', cwd };
    const plan = computeConfigBaselinePlan(event, cwd, home);
    expect(plan.map((p) => p.configSource).sort()).toEqual(['local_settings', 'user_settings']);

    const state: SessionState = freshState(T);
    applyConfigBaselinePlan(event, state, plan, T);
    expect(event.configChangeShapes?.length).toBe(2);
    for (const shape of event.configChangeShapes ?? []) {
      expect(shape.payload['trigger']).toBe('session_start');
      expect(shape.payload['writer']).toBe('none_observed');
    }
    // Stored, so the next real ConfigChange on this file diffs against it
    // instead of reading prior_unknown.
    expect(Object.keys(state.configSnapshots ?? {}).length).toBe(2);
  });

  it('is a no-op for a non-session_start event', () => {
    const event: HookEvent = { kind: 'tool_start', cwd };
    expect(computeConfigBaselinePlan(event, cwd, home)).toEqual([]);
  });
});
