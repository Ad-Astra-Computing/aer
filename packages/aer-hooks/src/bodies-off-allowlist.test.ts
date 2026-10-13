// A key the hook emits that ingest does not store is worse than a missing
// feature: the value crosses the wire, the operator pays the privacy cost, and
// the record gains nothing. AER_HOOK_RECORD_ARGS shipped exactly that way.
//
// So this drives every event kind the hook can emit and holds the emitted keys
// to the set ingest actually stores.

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { INGEST_PAYLOAD_KEYS, stripToIngestPayload } from './shared/ingest-allowlist.js';
import { emitHookEvent } from './core.js';
import { normalize } from './normalize.js';
import type { EventSink } from '@adastracomputing/aer-emit';

// A self-consistency pin on INGEST_PAYLOAD_KEYS alone, not a digest shared
// with the server: the two sides' key sets differ on purpose (see the
// comment on INGEST_PAYLOAD_KEYS) and the API repo has no matching pin to
// compare against. This only catches an accidental key change here. The
// real cross-repo guard is scripts/check-client-allowlist-parity.mjs in the
// monorepo; run it after changing INGEST_PAYLOAD_KEYS.
const ALLOWLIST_SHA256 = 'e73d838543880feded28803da7ba78f27e4521d14af91b9e5aa5b82f7426efff';

function collectingSink(): { sink: EventSink; seen: Array<{ type: string; payload: Record<string, unknown> }> } {
  const seen: Array<{ type: string; payload: Record<string, unknown> }> = [];
  return {
    seen,
    sink: {
      emit(type: string, payload: Record<string, unknown>) { seen.push({ type, payload }); },
      async close() {},
    } as unknown as EventSink,
  };
}

describe('the vendored allowlist matches the one ingest enforces', () => {
  it('has the pinned digest', () => {
    const digest = createHash('sha256').update([...INGEST_PAYLOAD_KEYS].sort().join('\n')).digest('hex');
    expect(digest).toBe(ALLOWLIST_SHA256);
  });

  it('drops an unknown key and names it without its value', () => {
    // Proves the helper does work: a check that cannot fail is not evidence.
    const { payload, dropped } = stripToIngestPayload({ tool: 'Bash', prompt: 'SECRET-TEXT' });
    expect(payload).toEqual({ tool: 'Bash' });
    expect(dropped).toEqual(['prompt']);
    expect(JSON.stringify(dropped)).not.toContain('SECRET-TEXT');
  });
});

// Realistic payloads per harness, one per event the installer registers.
const PAYLOADS: Array<{ label: string; raw: Record<string, unknown>; harness?: 'claude-code' | 'codex' | 'antigravity'; event?: string }> = [
  {
    label: 'claude-code PreToolUse',
    raw: {
      session_id: 'ses_1', hook_event_name: 'PreToolUse', tool_name: 'Bash',
      tool_input: { command: 'cat /etc/SECRET-FILE', description: 'read' },
      cwd: '/repo', permission_mode: 'default', transcript_path: '/t.jsonl',
    },
  },
  {
    label: 'claude-code PostToolUse',
    raw: {
      session_id: 'ses_1', hook_event_name: 'PostToolUse', tool_name: 'Bash',
      tool_input: { command: 'cat /etc/SECRET-FILE' },
      tool_response: { is_error: false, stdout: 'SECRET-OUTPUT' },
    },
  },
  { label: 'claude-code SessionStart', raw: { session_id: 'ses_1', hook_event_name: 'SessionStart', source: 'startup', model: 'claude-sonnet-4-5' } },
  { label: 'claude-code Stop', raw: { session_id: 'ses_1', hook_event_name: 'Stop', last_assistant_message: 'SECRET-REPLY' } },
  { label: 'claude-code UserPromptSubmit', raw: { session_id: 'ses_1', hook_event_name: 'UserPromptSubmit', prompt: 'SECRET-PROMPT' } },
  {
    label: 'codex PreToolUse',
    raw: {
      session_id: 'ses_2', turn_id: 't1', tool_use_id: 'tu_1', hook_event_name: 'PreToolUse',
      tool_name: 'shell', tool_input: { command: 'cat /etc/SECRET-FILE' }, model: 'gpt-6',
    },
  },
  {
    label: 'codex SessionEnd (carries transcript_path, a filesystem path never put on the wire)',
    raw: {
      session_id: 'ses_2', hook_event_name: 'SessionEnd', model: 'gpt-6', reason: 'exit',
      transcript_path: '/home/dev/.codex/sessions/2026/10/12/rollout-SECRET-abc.jsonl',
    },
  },
  {
    label: 'antigravity PreToolUse',
    raw: { conversationId: 'conv_1', stepIdx: 2, modelName: 'gemini', toolCall: { name: 'run_command', args: { command: 'cat /etc/SECRET-FILE' } } },
    harness: 'antigravity', event: 'PreToolUse',
  },
  {
    label: 'antigravity Stop',
    raw: { conversationId: 'conv_1', executionNum: 1, terminationReason: 'completed', fullyIdle: true },
    harness: 'antigravity', event: 'Stop',
  },
  // vcs.pushed (git push outcome + before/after ref): the shapesOfToolCall
  // reduction itself (branch_class/remote_class) is exercised here, same as
  // every other shape; the before/after ref lookup lives in vcs-push-plan.ts
  // and is exercised directly by vcs-push-plan.test.ts's round-trip test.
  {
    label: 'claude-code PreToolUse (git push)',
    raw: {
      session_id: 'ses_1', hook_event_name: 'PreToolUse', tool_name: 'Bash',
      tool_input: { command: 'git push origin feature-SECRET-branch' },
      cwd: '/repo',
    },
  },
  {
    label: 'codex PreToolUse (git push --force main)',
    raw: {
      session_id: 'ses_2', turn_id: 't1', tool_use_id: 'tu_1', hook_event_name: 'PreToolUse',
      tool_name: 'shell', tool_input: { command: 'git push --force origin main' },
    },
  },
  {
    label: 'antigravity PreToolUse (git push)',
    raw: { conversationId: 'conv_1', stepIdx: 3, toolCall: { name: 'run_command', args: { command: 'git push origin main' } } },
    harness: 'antigravity', event: 'PreToolUse',
  },
  // skill.invoked: the skill name only, never the arguments it was invoked with.
  {
    label: 'claude-code PreToolUse (Skill)',
    raw: {
      session_id: 'ses_1', hook_event_name: 'PreToolUse', tool_name: 'Skill',
      tool_input: { skill: 'pdf', args: 'SECRET-SKILL-ARGS' },
      cwd: '/repo',
    },
  },
];

describe('every key the hook emits is a key ingest stores', () => {
  for (const withValues of [false, true]) {
    it(`holds for every event kind (AER_HOOK_RECORD_ARGS=${withValues ? '1' : 'unset'})`, () => {
      const env = withValues ? { AER_HOOK_RECORD_ARGS: '1' } : {};
      const { sink, seen } = collectingSink();
      for (const { raw, harness, event } of PAYLOADS) {
        emitHookEvent(normalize(raw, harness, event), sink, { raw, env });
      }
      expect(seen.length).toBeGreaterThan(0);

      const offenders = new Set<string>();
      for (const { payload } of seen) {
        for (const key of Object.keys(payload)) {
          if (!INGEST_PAYLOAD_KEYS.has(key)) offenders.add(key);
        }
      }
      expect([...offenders].sort()).toEqual([]);
    });
  }

  it('never puts a prompt, an argument value or a result on the wire', () => {
    const env = { AER_HOOK_RECORD_ARGS: '1' };
    const { sink, seen } = collectingSink();
    for (const { raw, harness, event } of PAYLOADS) {
      emitHookEvent(normalize(raw, harness, event), sink, { raw, env });
    }
    const wire = JSON.stringify(seen);
    for (const secret of ['SECRET-FILE', 'SECRET-OUTPUT', 'SECRET-REPLY', 'SECRET-PROMPT', 'SECRET-branch', 'SECRET-abc', 'SECRET-SKILL-ARGS']) {
      expect(wire).not.toContain(secret);
    }
  });

  it('emits skill.invoked with the skill name only, never the args key', () => {
    const { sink, seen } = collectingSink();
    emitHookEvent(
      normalize({
        session_id: 'ses_1', hook_event_name: 'PreToolUse', tool_name: 'Skill',
        tool_input: { skill: 'pdf', args: 'SECRET-SKILL-ARGS' }, cwd: '/repo',
      }),
      sink,
    );
    const skillInvoked = seen.find((e) => e.type === 'skill.invoked');
    expect(skillInvoked?.payload['skill']).toBe('pdf');
    expect(skillInvoked?.payload['tool']).toBe('Skill');
    expect(JSON.stringify(skillInvoked?.payload)).not.toContain('SECRET-SKILL-ARGS');
    expect(Object.keys(skillInvoked?.payload ?? {}).sort()).toEqual(
      ['arg_keys', 'harness', 'session_ref', 'skill', 'tool'],
    );
  });
});
