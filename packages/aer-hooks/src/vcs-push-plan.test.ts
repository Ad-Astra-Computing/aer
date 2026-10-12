// vcs.pushed (git push outcome + before/after ref). `revParse` is injected
// (same DI pattern as root-session-join.test.ts's `parentPidOf`) so these
// tests never need a real git repo or a real subprocess: every rev-parse
// outcome (a clean hash, a rejection, a timeout, an adversarial stdout) is
// rigged directly.

import { describe, it, expect } from 'vitest';
import { computeVcsPushPlan, applyVcsPushPlan, revParse } from './vcs-push-plan.js';
import { freshState, type SessionState } from './session-store.js';
import type { HookEvent } from './normalize.js';
import type { ToolShape } from './tool-shape.js';

const T = 1_000_000;
const HASH_A = 'a'.repeat(40);
const HASH_B = 'b'.repeat(40);
const HASH_REFLOG = 'c'.repeat(64);

function gitPushShape(extra: Record<string, unknown> = {}): ToolShape {
  return { eventType: 'process.exec', payload: { command: 'git push', command_known: true, verb: 'git push', ...extra } };
}

function toolStart(toolUseId: string, shapes: ToolShape[], target?: { remote: string; branch: string }): HookEvent {
  const event: HookEvent = { kind: 'tool_start', tool: 'Bash', cwd: '/repo', meta: { tool_use_id: toolUseId }, shapes };
  if (target !== undefined) event.vcsPushTarget = target;
  return event;
}

function toolEnd(
  toolUseId: string,
  shapes: ToolShape[],
  isError: boolean | undefined,
  target?: { remote: string; branch: string },
): HookEvent {
  const event: HookEvent = { kind: 'tool_end', tool: 'Bash', cwd: '/repo', meta: { tool_use_id: toolUseId }, shapes };
  if (isError !== undefined) event.isError = isError;
  if (target !== undefined) event.vcsPushTarget = target;
  return event;
}

/** A rigged revParse: resolves canned answers by ref, never touches a real process. */
function riggedRevParse(table: Record<string, string | undefined>): (ref: string, cwd: string) => Promise<string | undefined> {
  return async (ref: string) => table[ref];
}

describe('computeVcsPushPlan + applyVcsPushPlan: tool_start', () => {
  it('does nothing for a harness with no tool_use_id', async () => {
    const event: HookEvent = { kind: 'tool_start', tool: 'Bash', shapes: [gitPushShape()] };
    const plan = await computeVcsPushPlan(event, undefined, '/fallback', T);
    expect(plan).toEqual({ kind: 'none' });
  });

  it('does nothing when the call is not a git push', async () => {
    const event = toolStart('tu1', [{ eventType: 'process.exec', payload: { command: 'ls', command_known: true } }]);
    const plan = await computeVcsPushPlan(event, undefined, '/fallback', T);
    expect(plan).toEqual({ kind: 'none' });
  });

  it('does nothing for an unresolvable push (no vcsPushTarget): bare push, multi-ref, delete, refspec colon', async () => {
    const event = toolStart('tu1', [gitPushShape()]); // no target: labelGit still ran, argv was not a single resolvable branch
    const plan = await computeVcsPushPlan(event, undefined, '/fallback', T);
    expect(plan).toEqual({ kind: 'none' });
  });

  it('stashes a validated before_ref for a resolvable push', async () => {
    const target = { remote: 'origin', branch: 'feature-x' };
    const event = toolStart('tu1', [gitPushShape({ remote_class: 'origin', branch_class: 'other' })], target);
    const deps = { revParse: riggedRevParse({ 'refs/remotes/origin/feature-x': HASH_A }) };
    const plan = await computeVcsPushPlan(event, undefined, '/fallback', T, deps);
    expect(plan).toEqual({ kind: 'tool_start', key: 'tu1', beforeRef: HASH_A });

    const state = freshState(T);
    applyVcsPushPlan(event, state, plan, T);
    expect(state.vcsPushStash).toEqual({ tu1: { stashedAt: T, beforeRef: HASH_A } });
  });

  it('stashes nothing when the before rev-parse finds nothing (brand-new branch, first push)', async () => {
    const target = { remote: 'origin', branch: 'brand-new' };
    const event = toolStart('tu1', [gitPushShape()], target);
    const deps = { revParse: riggedRevParse({ 'refs/remotes/origin/brand-new': undefined }) };
    const plan = await computeVcsPushPlan(event, undefined, '/fallback', T, deps);
    expect(plan).toEqual({ kind: 'none' });
  });

  it('a resolved before_ref never carries anything but the validated hash', async () => {
    const target = { remote: 'origin', branch: 'feature-x' };
    const event = toolStart('tu1', [gitPushShape()], target);
    const deps = { revParse: riggedRevParse({ 'refs/remotes/origin/feature-x': HASH_A }) };
    const plan = await computeVcsPushPlan(event, undefined, '/fallback', T, deps);
    expect(plan).toEqual({ kind: 'tool_start', key: 'tu1', beforeRef: HASH_A });
  });
});

describe('the real revParse() never forwards unvalidated stdout', () => {
  // A fake `git` on PATH, so the adversarial-output case is exercised through
  // a REAL subprocess call (not a rig standing in for it) without needing an
  // actual git repository. Canary-string technique, as elsewhere in this
  // package: if validation ever regressed to pass stdout through unchecked,
  // this is exactly what would leak.
  async function withFakeGit<T>(stdout: string, exitCode: number, fn: () => Promise<T>): Promise<T> {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aer-fake-git-'));
    const script = path.join(dir, 'git');
    // A heredoc with a quoted delimiter, never printf-with-an-escaped-
    // argument: printf's %s does not re-interpret backslash sequences in its
    // argument, so a JS template literal's REAL embedded newline would have
    // come out as the two literal characters `\`+`n`. A heredoc writes the
    // bytes exactly as given, including any real newline already in `stdout`.
    fs.writeFileSync(script, `#!/bin/sh\ncat <<'AER_EOF'\n${stdout}\nAER_EOF\nexit ${exitCode}\n`, { mode: 0o755 });
    const prevPath = process.env['PATH'];
    process.env['PATH'] = `${dir}${path.delimiter}${prevPath ?? ''}`;
    try {
      return await fn();
    } finally {
      process.env['PATH'] = prevPath;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('rejects a canary string, a tag name, empty output, and a trailing second line', async () => {
    for (const stdout of ['SECRET-CANARY', 'v1.2.3', '', `${HASH_A}\nSECRET-SECOND-LINE`]) {
      const result = await withFakeGit(stdout, 0, () => revParse('HEAD', process.cwd()));
      expect(result).toBeUndefined();
      expect(JSON.stringify(result ?? null)).not.toContain('SECRET');
    }
  });

  it('rejects a well-formed hash on a non-zero exit (the call still failed)', async () => {
    const result = await withFakeGit(HASH_A, 1, () => revParse('HEAD', process.cwd()));
    expect(result).toBeUndefined();
  });

  it('accepts a bare 40-hex id, trimming surrounding whitespace', async () => {
    const result = await withFakeGit(`  ${HASH_A}`, 0, () => revParse('HEAD', process.cwd()));
    expect(result).toBe(HASH_A);
  });

  it('accepts a bare 64-hex id (SHA-256 repos)', async () => {
    const result = await withFakeGit(HASH_REFLOG, 0, () => revParse('HEAD', process.cwd()));
    expect(result).toBe(HASH_REFLOG);
  });

  it('never hangs past its timeout on a command that never exits', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aer-fake-git-hang-'));
    const script = path.join(dir, 'git');
    fs.writeFileSync(script, '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
    const prevPath = process.env['PATH'];
    process.env['PATH'] = `${dir}${path.delimiter}${prevPath ?? ''}`;
    try {
      const started = Date.now();
      const result = await revParse('HEAD', process.cwd());
      expect(result).toBeUndefined();
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      process.env['PATH'] = prevPath;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);
});

describe('computeVcsPushPlan + applyVcsPushPlan: tool_end', () => {
  it('does nothing when the call is not a git push', async () => {
    const event = toolEnd('tu1', [{ eventType: 'process.exec', payload: { command: 'ls', command_known: true } }], false);
    const plan = await computeVcsPushPlan(event, undefined, '/fallback', T);
    expect(plan).toEqual({ kind: 'none' });
  });

  it('accepted push with both before and after ref present: outcome accepted, both refs 40/64-hex', async () => {
    const target = { remote: 'origin', branch: 'feature-x' };
    const stashSnapshot = { tu1: { beforeRef: HASH_A, stashedAt: T } };
    const event = toolEnd('tu1', [gitPushShape({ remote_class: 'origin', branch_class: 'other' })], false, target);
    const deps = { revParse: riggedRevParse({ 'feature-x': HASH_B }) };
    const plan = await computeVcsPushPlan(event, stashSnapshot, '/fallback', T + 100, deps);
    expect(plan).toEqual({
      kind: 'tool_end',
      appendShape: {
        eventType: 'vcs.pushed',
        payload: { outcome: 'accepted', remote_class: 'origin', branch_class: 'other', before_ref: HASH_A, after_ref: HASH_B },
      },
      consumedKey: 'tu1',
    });

    const state: SessionState = { ...freshState(T), vcsPushStash: stashSnapshot };
    applyVcsPushPlan(event, state, plan, T + 100);
    expect(state.vcsPushStash).toBeUndefined();
    expect(event.effectShapes).toEqual([plan.appendShape]);
  });

  // Judgment call (flagged for review): a rejected push still gets both refs
  // when they resolve. before_ref/after_ref are honest local reads (the
  // remote-tracking ref before the attempt, the local branch tip after it),
  // not a claim the remote now matches after_ref; `outcome` carries that
  // claim. An equally defensible alternative is to omit after_ref on a
  // rejection since the remote never actually moved to it.
  it('rejected push (non-zero exit): outcome rejected, refs still reported when they resolve', async () => {
    const target = { remote: 'origin', branch: 'main' };
    const stashSnapshot = { tu1: { beforeRef: HASH_A, stashedAt: T } };
    const event = toolEnd('tu1', [gitPushShape({ remote_class: 'origin', branch_class: 'protected' })], true, target);
    const deps = { revParse: riggedRevParse({ main: HASH_B }) };
    const plan = await computeVcsPushPlan(event, stashSnapshot, '/fallback', T + 100, deps);
    if (plan.kind !== 'tool_end') throw new Error('unreachable');
    expect(plan.appendShape.payload['outcome']).toBe('rejected');
    expect(plan.appendShape.payload['before_ref']).toBe(HASH_A);
    expect(plan.appendShape.payload['after_ref']).toBe(HASH_B);
  });

  it('unresolvable push (no vcsPushTarget): degrades to outcome unknown, no refs, even on a clean exit', async () => {
    const event = toolEnd('tu1', [gitPushShape({ remote_class: 'origin' })], false); // no target: multi-refspec/delete/HEAD:foo/bare/remote-only
    const plan = await computeVcsPushPlan(event, undefined, '/fallback', T, {});
    expect(plan).toEqual({ kind: 'tool_end', appendShape: { eventType: 'vcs.pushed', payload: { outcome: 'unknown', remote_class: 'origin' } } });
  });

  it('reflog fallback: no stash entry (lost to TTL, a restart, or no pre-exec signal) tries <remote>/<branch>@{1} for before_ref', async () => {
    const target = { remote: 'origin', branch: 'feature-x' };
    const event = toolEnd('tu1', [gitPushShape()], false, target);
    const deps = { revParse: riggedRevParse({ 'feature-x': HASH_B, 'origin/feature-x@{1}': HASH_REFLOG }) };
    const plan = await computeVcsPushPlan(event, undefined, '/fallback', T, deps);
    if (plan.kind !== 'tool_end') throw new Error('unreachable');
    expect(plan.appendShape.payload['before_ref']).toBe(HASH_REFLOG);
    expect(plan.appendShape.payload['after_ref']).toBe(HASH_B);
    expect(plan.consumedKey).toBeUndefined(); // nothing was stashed, so nothing to consume
  });

  it('reflog fallback that also fails: before_ref is omitted, never guessed; the event is still emitted', async () => {
    const target = { remote: 'origin', branch: 'feature-x' };
    const event = toolEnd('tu1', [gitPushShape()], false, target);
    const deps = { revParse: riggedRevParse({ 'feature-x': HASH_B, 'origin/feature-x@{1}': undefined }) };
    const plan = await computeVcsPushPlan(event, undefined, '/fallback', T, deps);
    if (plan.kind !== 'tool_end') throw new Error('unreachable');
    expect(plan.appendShape.payload['before_ref']).toBeUndefined();
    expect(plan.appendShape.payload['after_ref']).toBe(HASH_B);
  });

  it('only consumes the stash entry for its own tool_use_id', async () => {
    const stashSnapshot = { tu1: { beforeRef: HASH_A, stashedAt: T }, tu2: { beforeRef: HASH_B, stashedAt: T } };
    const target = { remote: 'origin', branch: 'feature-x' };
    const event = toolEnd('tu1', [gitPushShape()], false, target);
    const deps = { revParse: riggedRevParse({ 'feature-x': HASH_B }) };
    const plan = await computeVcsPushPlan(event, stashSnapshot, '/fallback', T, deps);
    if (plan.kind !== 'tool_end') throw new Error('unreachable');
    expect(plan.consumedKey).toBe('tu1');

    const state: SessionState = { ...freshState(T), vcsPushStash: stashSnapshot };
    applyVcsPushPlan(event, state, plan, T);
    expect(Object.keys(state.vcsPushStash!)).toEqual(['tu2']);
  });

  it('round-trips through the vendored allowlist: every key it emits is one ingest stores', async () => {
    const { INGEST_PAYLOAD_KEYS } = await import('./shared/ingest-allowlist.js');
    const target = { remote: 'origin', branch: 'feature-x' };
    const stashSnapshot = { tu1: { beforeRef: HASH_A, stashedAt: T } };
    const event = toolEnd('tu1', [gitPushShape({ remote_class: 'origin', branch_class: 'other' })], false, target);
    const deps = { revParse: riggedRevParse({ 'feature-x': HASH_B }) };
    const plan = await computeVcsPushPlan(event, stashSnapshot, '/fallback', T, deps);
    if (plan.kind !== 'tool_end') throw new Error('unreachable');
    for (const key of Object.keys(plan.appendShape.payload)) {
      expect(INGEST_PAYLOAD_KEYS.has(key)).toBe(true);
    }
  });
});
