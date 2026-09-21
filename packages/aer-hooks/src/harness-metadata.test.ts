// What the record learns about the run itself: which harness, which model,
// which permission mode, and on Claude Code the reasoning effort.
//
// Each harness exposes a different subset, and the rule is the same one we
// use for every field: record it where the harness gives it, omit it where it
// does not, and never derive it from something that merely looks like it.

import { describe, it, expect } from 'vitest';
import { normalizeClaudeCode, normalizeCodex, normalizeAntigravity, identifier } from './normalize.js';
import { emitHookEvent } from './core.js';
import { INGEST_PAYLOAD_KEYS } from './shared/ingest-allowlist.js';
import type { EventSink } from '@adastracomputing/aer-emit';

function capture(): { sink: EventSink; events: { type: string; payload: Record<string, unknown> }[] } {
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  const sink = {
    emit: (type: string, payload: Record<string, unknown>) => {
      events.push({ type, payload });
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
  } as unknown as EventSink;
  return { sink, events };
}

describe('Claude Code metadata', () => {
  it('records the model, source and permission mode from SessionStart', () => {
    const e = normalizeClaudeCode({
      hook_event_name: 'SessionStart',
      session_id: 's1',
      source: 'startup',
      model: 'claude-opus-5',
      permission_mode: 'acceptEdits',
    }, 2);
    expect(e.meta).toEqual({
      harness: 'claude-code',
      model: 'claude-opus-5',
      source: 'startup',
      permission_mode: 'acceptEdits',
    });
  });

  it('records the reasoning effort, which only this harness reports', () => {
    // `effort` is nested and arrives on events in a tool-use context. It is
    // recorded because it is there, not withheld because Codex and
    // Antigravity have no equivalent.
    const e = normalizeClaudeCode({
      hook_event_name: 'PreToolUse',
      session_id: 's1',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      effort: { level: 'xhigh' },
    }, 2);
    expect(e.meta?.['effort']).toBe('xhigh');
  });

  it('groups a turn by prompt_id, which the docs do not mention', () => {
    // Probing the running CLI found it on every event after the first input.
    // It is the same correlator Codex calls turn_id, so it is recorded under
    // that name and a reader does not need to know which harness ran.
    const e = normalizeClaudeCode({
      hook_event_name: 'PreToolUse', session_id: 's1', prompt_id: 'pr_01ABC',
      tool_name: 'Read', tool_input: { file_path: '/a' },
    }, 2);
    expect(e.meta?.['turn_id']).toBe('pr_01ABC');
  });

  it('does not report a model this harness never sends', () => {
    // Probing the running CLI found no model field on any event and no
    // CLAUDE_MODEL in the environment, whatever the docs say. The key is
    // absent rather than filled from somewhere it does not belong.
    const e = normalizeClaudeCode({ hook_event_name: 'SessionStart', session_id: 's1', source: 'startup' }, 2);
    expect(e.meta).not.toHaveProperty('model');
  });

  it('records the reason a session ended', () => {
    const e = normalizeClaudeCode({ hook_event_name: 'SessionEnd', session_id: 's1', reason: 'clear' }, 2);
    expect(e.kind).toBe('session_end');
    expect(e.meta?.['reason']).toBe('clear');
  });

  it('pairs a tool start with its completion through tool_use_id', () => {
    const start = normalizeClaudeCode({
      hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Bash',
      tool_input: { command: 'ls' }, tool_use_id: 'toolu_01ABC',
    }, 2);
    const end = normalizeClaudeCode({
      hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Bash',
      tool_response: { stdout: 'x' }, tool_use_id: 'toolu_01ABC', duration_ms: 42,
    }, 2);
    expect(start.meta?.['tool_use_id']).toBe('toolu_01ABC');
    expect(end.meta?.['tool_use_id']).toBe('toolu_01ABC');
    expect(end.meta?.['duration_ms']).toBe(42);
  });

  it('treats a dedicated failure event as the failure, without reading its text', () => {
    const e = normalizeClaudeCode({
      hook_event_name: 'PostToolUseFailure', session_id: 's1', tool_name: 'Bash',
      error: 'cat: /etc/SECRET-FILE: Permission denied',
    }, 2);
    expect(e.kind).toBe('tool_end');
    expect(e.isError).toBe(true);
    expect(JSON.stringify(e)).not.toContain('SECRET-FILE');
  });

  it('records a subagent as a subagent, not as a session boundary', () => {
    // SubagentStop used to map to session_end, which would have completed the
    // record the moment a Task finished, mid-run.
    expect(normalizeClaudeCode({ hook_event_name: 'SubagentStart', session_id: 's1', agent_type: 'Explore' }, 2))
      .toMatchObject({ kind: 'subagent_start', meta: { agent_type: 'Explore' } });
    expect(normalizeClaudeCode({ hook_event_name: 'SubagentStop', session_id: 's1' }, 2).kind)
      .toBe('subagent_end');
  });
});

describe('Codex metadata', () => {
  it('records the model and turn, which Codex sends on every event', () => {
    const e = normalizeCodex({
      hook_event_name: 'PreToolUse', session_id: 's1', model: 'gpt-5.1-codex',
      turn_id: 'turn-4', tool_use_id: 'call_abc', tool_name: 'shell',
      tool_input: { command: 'ls' }, permission_mode: 'auto',
    }, 2);
    expect(e.meta).toMatchObject({
      harness: 'codex', model: 'gpt-5.1-codex', turn_id: 'turn-4',
      tool_use_id: 'call_abc', permission_mode: 'auto',
    });
  });

  it('has no effort to record, and does not invent one', () => {
    // Codex keeps reasoning effort in config.toml and never puts it on a hook
    // payload, so the key is absent rather than guessed.
    const e = normalizeCodex({ hook_event_name: 'SessionStart', session_id: 's1', model: 'gpt-5.1-codex' }, 2);
    expect(e.meta).not.toHaveProperty('effort');
  });
});

describe('Antigravity metadata', () => {
  it('records modelName, which it sends on every event', () => {
    const e = normalizeAntigravity({ conversationId: 'c1', modelName: 'gemini-3.6-flash-medium' }, 'PreInvocation');
    expect(e.meta).toMatchObject({ harness: 'antigravity', model: 'gemini-3.6-flash-medium' });
  });

  it('does not read an effort level out of the model id', () => {
    // The `-medium` suffix is part of a model name. Nothing documents it as a
    // thinking level, and a signed record must not carry a guess.
    const e = normalizeAntigravity({ conversationId: 'c1', modelName: 'gemini-3.6-flash-medium' }, 'PreInvocation');
    expect(e.meta).not.toHaveProperty('effort');
  });

  it('has no tool id to pair on, and says so by omission', () => {
    const e = normalizeAntigravity(
      { conversationId: 'c1', toolCall: { name: 'run_command', args: { command: 'ls' } }, stepIdx: 3 },
      'PreToolUse',
    );
    expect(e.tool).toBe('run_command');
    expect(e.meta).not.toHaveProperty('tool_use_id');
  });
});

describe('metadata values are identifiers, never prose', () => {
  it('accepts the shapes harnesses actually send', () => {
    for (const s of [
      'claude-opus-5', 'gpt-5.1-codex', 'anthropic/claude-opus-5', 'turn-4',
      'toolu_01ABC', 'xhigh', 'acceptEdits', 'gemini-3.8-flash-high',
      // A real model id carries a bracketed variant, and dropping the model
      // because of a bracket loses the field the record is there to carry.
      'claude-opus-5[1m]',
    ]) {
      expect(identifier(s)).toBe(s);
    }
  });

  it('drops anything that could carry content', () => {
    // `reason` and `terminationReason` are documented as labels, but nothing
    // stops a harness putting a sentence or a command line in one.
    for (const s of ['the user pressed ctrl-c', 'cat /etc/SECRET-FILE', '/home/dev/SECRET-PROJECT/x.ts', 'a'.repeat(200), '']) {
      expect(identifier(s)).toBeUndefined();
    }
  });

  it('drops a prose terminationReason rather than recording it', () => {
    const e = normalizeAntigravity(
      { conversationId: 'c1', fullyIdle: true, terminationReason: 'model said: SECRET-REPLY' },
      'Stop',
    );
    expect(JSON.stringify(e)).not.toContain('SECRET-REPLY');
  });
});

describe('every metadata key survives the ingest allowlist', () => {
  it('emits nothing ingest would discard', () => {
    const payloads = [
      normalizeClaudeCode({
        hook_event_name: 'SessionStart', session_id: 's1', source: 'resume',
        model: 'claude-opus-5', permission_mode: 'plan', effort: { level: 'max' },
      }, 2),
      normalizeClaudeCode({
        hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Bash',
        tool_input: { command: 'ls' }, tool_response: { stdout: 'x' },
        tool_use_id: 'toolu_1', duration_ms: 12, effort: { level: 'high' },
      }, 2),
      normalizeCodex({ hook_event_name: 'Stop', session_id: 's1', model: 'gpt-5.1-codex', turn_id: 't1' }, 2),
      normalizeAntigravity({ conversationId: 'c1', modelName: 'gemini-3.6-flash', fullyIdle: true, terminationReason: 'COMPLETED' }, 'Stop'),
    ];
    for (const event of payloads) {
      const { sink, events } = capture();
      event.seq = 3;
      emitHookEvent(event, sink);
      expect(events).toHaveLength(1);
      const emitted = events[0]!.payload;
      // The emitter filters against the allowlist, so reading the keys it let
      // through proves nothing. Read the keys the normalizer PRODUCED: a
      // metadata field ingest would discard has to fail here, or we would
      // send it, lose it, and never notice.
      for (const key of Object.keys(event.meta ?? {})) {
        expect(INGEST_PAYLOAD_KEYS.has(key), `${key} is dropped at ingest`).toBe(true);
        expect(emitted[key], `${key} did not survive the emit`).toBeDefined();
      }
      expect(emitted['harness']).toBeDefined();
      expect(emitted['seq']).toBe(3);
    }
  });
});

describe('an event ingest would reject is never sent as one', () => {
  it('records an unnamed tool call as unnamed, rather than as a tool event', () => {
    // The API requires `tool` on tool.started and tool.completed and rejects
    // the event without it, so sending one loses the call silently. A marker
    // keeps the call in the record and stays countable.
    for (const kind of ['tool_start', 'tool_end'] as const) {
      const { sink, events } = capture();
      emitHookEvent({ kind, argKeys: ['a'], meta: { harness: 'codex' } }, sink);
      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe('collector.report');
      expect(events[0]!.payload['phase']).toBe('tool_unnamed');
      expect(events[0]!.payload['collector']).toBe('aer-hooks');
    }
  });

  it('still sends a proper tool event when the name is there', () => {
    const { sink, events } = capture();
    emitHookEvent({ kind: 'tool_start', tool: 'Bash', meta: { harness: 'codex' } }, sink);
    expect(events[0]!.type).toBe('tool.started');
    expect(events[0]!.payload['tool']).toBe('Bash');
  });
});
