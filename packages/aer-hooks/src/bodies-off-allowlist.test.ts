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

// Pinned against BODIES_OFF_PAYLOAD_KEYS in the API repo (packages/schemas/
// src/event.ts), which carries the same digest in its own test. A change on
// either side turns both red, so the two copies cannot drift in silence.
const ALLOWLIST_SHA256 = '8f04d6df225ece29873c34a883037f3e8395294a10136bb22f83ecacdcfee8e1';

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
    label: 'antigravity PreToolUse',
    raw: { conversationId: 'conv_1', stepIdx: 2, modelName: 'gemini', toolCall: { name: 'run_command', args: { command: 'cat /etc/SECRET-FILE' } } },
    harness: 'antigravity', event: 'PreToolUse',
  },
  {
    label: 'antigravity Stop',
    raw: { conversationId: 'conv_1', executionNum: 1, terminationReason: 'completed', fullyIdle: true },
    harness: 'antigravity', event: 'Stop',
  },
];

describe('every key the hook emits is a key ingest stores', () => {
  for (const withValues of [false, true]) {
    it(`holds for every event kind (AER_HOOK_RECORD_ARGS=${withValues ? '1' : 'unset'})`, () => {
      const env = withValues ? { AER_HOOK_RECORD_ARGS: '1' } : {};
      const { sink, seen } = collectingSink();
      for (const { raw, harness, event } of PAYLOADS) {
        emitHookEvent(normalize(raw, harness, env, event), sink, { raw, env });
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
      emitHookEvent(normalize(raw, harness, env, event), sink, { raw, env });
    }
    const wire = JSON.stringify(seen);
    for (const secret of ['SECRET-FILE', 'SECRET-OUTPUT', 'SECRET-REPLY', 'SECRET-PROMPT']) {
      expect(wire).not.toContain(secret);
    }
  });
});
