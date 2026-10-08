import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { computeEffectDigestPlan, applyEffectDigestPlan } from './effect-digest-plan.js';
import { freshState, type SessionState } from './session-store.js';
import type { HookEvent } from './normalize.js';

// Outside the real worktree's .git and outside the OS tmp root (which itself
// classifies as PathClass 'tmp'); see effect-digest.test.ts for why.
const SCRATCH_ROOT = path.join(os.homedir(), '.aer-effect-digest-plan-test-scratch');
let dir: string;

beforeEach(() => {
  fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
  dir = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'case-'));
});
afterEach(() => fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true }));

const KEY = Buffer.alloc(32, 0x01);
const T = 1_000_000;

function toolStart(toolUseId: string, path: string, cwd: string): HookEvent {
  return {
    kind: 'tool_start', tool: 'Write', cwd,
    meta: { tool_use_id: toolUseId },
    shapes: [{ eventType: 'file.written', payload: { path } }],
  };
}

function toolEnd(toolUseId: string, cwd: string): HookEvent {
  return { kind: 'tool_end', tool: 'Write', cwd, meta: { tool_use_id: toolUseId } };
}

describe('computeEffectDigestPlan + applyEffectDigestPlan: tool_start', () => {
  it('does nothing for a harness with no tool_use_id', async () => {
    const event: HookEvent = { kind: 'tool_start', tool: 'Write', cwd: dir, shapes: [{ eventType: 'file.written', payload: { path: path.join(dir, 'a.ts') } }] };
    const plan = await computeEffectDigestPlan(event, undefined, KEY, T);
    expect(plan).toEqual({ kind: 'none' });
  });

  it('does nothing when no commitment key is configured', async () => {
    const event = toolStart('tu1', path.join(dir, 'a.ts'), dir);
    const plan = await computeEffectDigestPlan(event, undefined, null, T);
    expect(plan).toEqual({ kind: 'none' });
  });

  it('stashes a before-digest and removes the file.written shape for a hashable new file', async () => {
    const filePath = path.join(dir, 'new.ts');
    const event = toolStart('tu1', filePath, dir);
    const plan = await computeEffectDigestPlan(event, undefined, KEY, T);
    expect(plan.kind).toBe('tool_start');
    if (plan.kind !== 'tool_start') throw new Error('unreachable');
    expect(plan.keptShapes).toEqual([]);
    expect(plan.newEntries).toEqual([{ key: `tu1::${filePath}`, path: filePath }]);

    const state = freshState(T);
    applyEffectDigestPlan(event, state, plan, T);
    expect(event.shapes).toEqual([]);
    expect(state.effectStash).toEqual({ [`tu1::${filePath}`]: { path: filePath, stashedAt: T } });
  });

  it('stashes a sha256Before for an existing file', async () => {
    const filePath = path.join(dir, 'existing.ts');
    fs.writeFileSync(filePath, 'hello world');
    const event = toolStart('tu1', filePath, dir);
    const plan = await computeEffectDigestPlan(event, undefined, KEY, T);
    if (plan.kind !== 'tool_start') throw new Error('unreachable');
    expect(plan.newEntries[0]!.sha256Before).toBe('46b5cdf815859bf739f6d07509de297df65d5444ea08193bb933e2c22492e7ed');
  });

  it('leaves a non-hashable shape untouched (outside workspace / credential class)', async () => {
    const event = toolStart('tu1', '/etc/passwd', dir);
    const plan = await computeEffectDigestPlan(event, undefined, KEY, T);
    expect(plan).toEqual({ kind: 'none' });
  });
});

describe('computeEffectDigestPlan + applyEffectDigestPlan: tool_end', () => {
  it('does nothing with no matching stash entries', async () => {
    const event = toolEnd('tu1', dir);
    const plan = await computeEffectDigestPlan(event, undefined, KEY, T);
    expect(plan).toEqual({ kind: 'none' });
  });

  it('emits a combined before/after file.written and clears the stash entry', async () => {
    const filePath = path.join(dir, 'written.ts');
    fs.writeFileSync(filePath, 'hello world'); // the "after" content
    const stashSnapshot = { [`tu1::${filePath}`]: { path: filePath, sha256Before: 'a'.repeat(64), stashedAt: T } };
    const event = toolEnd('tu1', dir);
    const plan = await computeEffectDigestPlan(event, stashSnapshot, KEY, T + 1000);
    expect(plan.kind).toBe('tool_end');
    if (plan.kind !== 'tool_end') throw new Error('unreachable');
    expect(plan.consumedKeys).toEqual([`tu1::${filePath}`]);
    expect(plan.appendShapes).toEqual([{
      eventType: 'file.written',
      payload: {
        path: filePath, hash_status: 'ok',
        sha256_before: 'a'.repeat(64),
        sha256_after: '46b5cdf815859bf739f6d07509de297df65d5444ea08193bb933e2c22492e7ed',
        bytes: 11, kid: '9f4cf7d8f8f38243',
      },
    }]);

    const state: SessionState = { ...freshState(T), effectStash: stashSnapshot };
    applyEffectDigestPlan(event, state, plan, T + 1000);
    expect(state.effectStash).toBeUndefined();
    expect(event.effectShapes).toEqual(plan.appendShapes);
  });

  it('reports a failure status (no digest fields) when the after-read fails, e.g. a symlink swapped in', async () => {
    const target = path.join(dir, 'real.ts');
    fs.writeFileSync(target, 'x');
    const linkPath = path.join(dir, 'swapped.ts');
    fs.symlinkSync(target, linkPath);
    const stashSnapshot = { [`tu1::${linkPath}`]: { path: linkPath, stashedAt: T } };
    const event = toolEnd('tu1', dir);
    const plan = await computeEffectDigestPlan(event, stashSnapshot, KEY, T + 1000);
    if (plan.kind !== 'tool_end') throw new Error('unreachable');
    expect(plan.appendShapes).toEqual([{ eventType: 'file.written', payload: { path: linkPath, hash_status: 'symlink' } }]);
  });

  it('only consumes entries for its own tool_use_id, leaving others untouched', async () => {
    const stashSnapshot = {
      'tu1::/a.ts': { path: '/a.ts', stashedAt: T },
      'tu2::/b.ts': { path: '/b.ts', stashedAt: T },
    };
    const event = toolEnd('tu1', dir);
    const plan = await computeEffectDigestPlan(event, stashSnapshot, KEY, T + 1000);
    if (plan.kind !== 'tool_end') throw new Error('unreachable');
    expect(plan.consumedKeys).toEqual(['tu1::/a.ts']);

    const state: SessionState = { ...freshState(T), effectStash: stashSnapshot };
    applyEffectDigestPlan(event, state, plan, T + 1000);
    expect(Object.keys(state.effectStash!)).toEqual(['tu2::/b.ts']);
  });

  it('consumes a matched entry with no digest computed when there is no commitment key', async () => {
    const stashSnapshot = { 'tu1::/a.ts': { path: '/a.ts', stashedAt: T } };
    const event = toolEnd('tu1', dir);
    const plan = await computeEffectDigestPlan(event, stashSnapshot, null, T + 1000);
    if (plan.kind !== 'tool_end') throw new Error('unreachable');
    expect(plan.consumedKeys).toEqual(['tu1::/a.ts']);
    expect(plan.appendShapes).toEqual([]);
  });
});
