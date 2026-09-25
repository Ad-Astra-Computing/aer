// ADR-023 B6: fixtures pinning the specific fields the review called out by
// name. bodies-off-allowlist.test.ts already drives every event kind through
// the real allowlist; this file targets the exact payloads that review named.

import { describe, it, expect } from 'vitest';
import { emitHookEvent } from './core.js';
import { normalize } from './normalize.js';
import type { EventSink } from '@adastracomputing/aer-emit';

function emitOne(raw: Record<string, unknown>, harness?: 'claude-code' | 'codex' | 'antigravity', eventName?: string): string {
  const seen: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const sink: EventSink = {
    emit(type, payload) { seen.push({ type, payload: { ...payload } }); },
    async close() {},
  };
  emitHookEvent(normalize(raw, harness, eventName), sink);
  return JSON.stringify(seen);
}

describe('B6: SubagentStop never carries the assistant reply or its background tasks', () => {
  it('claude-code SubagentStop drops last_assistant_message and background_tasks', () => {
    const wire = emitOne({
      session_id: 's1',
      hook_event_name: 'SubagentStop',
      agent_type: 'reviewer',
      last_assistant_message: 'SECRET the plan is to exfiltrate nothing',
      background_tasks: [{ id: 't1', status: 'running', description: 'SECRET-TASK' }],
      agent_transcript_path: '/home/user/.claude/secret-transcript.jsonl',
    });
    expect(wire).not.toContain('SECRET');
    expect(wire).not.toContain('last_assistant_message');
    expect(wire).not.toContain('background_tasks');
    expect(wire).not.toContain('secret-transcript');
  });
});

describe('B6: permission hooks never carry tool_input', () => {
  it('claude-code PermissionRequest drops tool_input', () => {
    const wire = emitOne({
      session_id: 's1',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'cat ~/.ssh/id_ed25519', description: 'SECRET-REASON' },
    });
    expect(wire).not.toContain('tool_input');
    expect(wire).not.toContain('id_ed25519');
    expect(wire).not.toContain('SECRET-REASON');
  });

  it('claude-code PermissionDenied drops tool_input', () => {
    const wire = emitOne({
      session_id: 's1',
      hook_event_name: 'PermissionDenied',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /', reason: 'SECRET-REASON' },
    });
    expect(wire).not.toContain('tool_input');
    expect(wire).not.toContain('SECRET-REASON');
  });

  it('codex PermissionRequest drops tool_input', () => {
    const wire = emitOne({
      session_id: 's2', turn_id: 't1', hook_event_name: 'PermissionRequest',
      tool_name: 'shell', tool_input: { command: 'curl SECRET-URL' },
    }, 'codex');
    expect(wire).not.toContain('tool_input');
    expect(wire).not.toContain('SECRET-URL');
  });
});

describe('B6: SubagentStart carries only harness_agent_id and agent_type', () => {
  it('drops every other field on the payload', () => {
    const wire = emitOne({
      session_id: 's1',
      hook_event_name: 'SubagentStart',
      agent_id: 'agent-42',
      agent_type: 'reviewer',
      agent_transcript_path: '/home/user/.claude/agent-secret.jsonl',
      prompt: 'SECRET-PROMPT',
      description: 'SECRET-DESCRIPTION',
    });
    expect(wire).toContain('agent-42');
    expect(wire).toContain('reviewer');
    expect(wire).not.toContain('SECRET-PROMPT');
    expect(wire).not.toContain('SECRET-DESCRIPTION');
    expect(wire).not.toContain('agent-secret');
    expect(wire).not.toContain('agent_transcript_path');
    expect(wire).not.toContain('prompt');
    expect(wire).not.toContain('description');
  });
});
