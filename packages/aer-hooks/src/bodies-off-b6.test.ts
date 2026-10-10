// ADR-023 B6: fixtures pinning the specific fields the review called out by
// name. bodies-off-allowlist.test.ts already drives every event kind through
// the real allowlist; this file targets the exact payloads that review named.

import { describe, it, expect } from 'vitest';
import { emitHookEvent } from './core.js';
import { normalize } from './normalize.js';
import { stripToIngestPayload } from './shared/ingest-allowlist.js';
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

// No aer-hooks adapter reads Codex OTel today, so there is no live code path
// to drive an event through. This fixture guards the shared allowlist itself
// (the mechanism ANY future OTel adapter would have to route through) against
// a Codex-shaped `tool_result` span, so the day such an adapter is written it
// inherits a passing test rather than a silent leak.
describe('B6: a future Codex OTel adapter cannot leak tool_result args/output', () => {
  it('the shared allowlist strips a Codex-shaped OTel tool_result span', () => {
    const otelToolResultSpan = {
      tool: 'shell',
      tool_use_id: 'call_abc123',
      args: { command: 'cat ~/.ssh/id_ed25519', cwd: '/home/user/project' },
      output: 'SECRET-STDOUT-CONTENTS',
      is_error: false,
      duration_ms: 42,
    };
    const { payload, dropped } = stripToIngestPayload(otelToolResultSpan);
    expect(payload).not.toHaveProperty('args');
    expect(payload).not.toHaveProperty('output');
    expect(dropped.sort()).toEqual(['args', 'output']);
    expect(JSON.stringify(payload)).not.toContain('SECRET-STDOUT-CONTENTS');
    expect(JSON.stringify(payload)).not.toContain('id_ed25519');
    // What a bodies-off adapter IS allowed to keep: identifiers and outcome flags.
    expect(payload['tool']).toBe('shell');
    expect(payload['tool_use_id']).toBe('call_abc123');
    expect(payload['is_error']).toBe(false);
    expect(payload['duration_ms']).toBe(42);
  });
});

// Malicious-behaviour detection slice 1: the closed-set labels computed in
// shell-line.ts/tool-shape.ts are argv/path/pattern-derived, so this suite
// feeds adversarial canary strings through the real hook pipeline and
// proves none of them ever reaches the wire, only the labels they produced.
describe('slice 1: risk labels never carry the raw argv, path, branch name or search pattern', () => {
  it('a sudo-wrapped rm -rf on a canary-named directory emits labels, never the path', () => {
    const wire = emitOne({
      session_id: 's1',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'sudo rm -rf /home/CANARYUSER/CANARYSECRETDIR' },
    });
    expect(wire).not.toContain('CANARYUSER');
    expect(wire).not.toContain('CANARYSECRETDIR');
    expect(wire).toContain('"wrapper":"sudo"');
    expect(wire).toContain('"verb":"rm"');
    expect(wire).toContain('"recursive"');
    expect(wire).toContain('"force"');
  });

  it('a git push --force to a canary branch emits branch_class, never the branch name', () => {
    const wire = emitOne({
      session_id: 's1',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git push --force origin CANARYBRANCHNAME' },
    });
    expect(wire).not.toContain('CANARYBRANCHNAME');
    expect(wire).toContain('"branch_class":"other"');
    expect(wire).toContain('"remote_class":"origin"');
  });

  it('a claude CLI with a bypass flag and a canary extra flag emits ai_cli without the extra', () => {
    const wire = emitOne({
      session_id: 's1',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'claude --dangerously-skip-permissions --model CANARYMODEL -p "CANARYPROMPT"' },
    });
    expect(wire).not.toContain('CANARYMODEL');
    expect(wire).not.toContain('CANARYPROMPT');
    expect(wire).toContain('"ai_cli"');
    expect(wire).toContain('--dangerously-skip-permissions');
  });

  it('a shell-out through sh -c reduces to the wrapped verb, never the -c string', () => {
    const wire = emitOne({
      session_id: 's1',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'sudo sh -c "rm -rf /CANARYPATH"' },
    });
    expect(wire).not.toContain('CANARYPATH');
    expect(wire).toContain('"wrapper":"sudo"');
    expect(wire).toContain('"verb":"rm"');
  });

  it('python -c stays opaque: interpreter_inline only, never the inline code', () => {
    const wire = emitOne({
      session_id: 's1',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'python -c "CANARYPYTHONCODE"' },
    });
    expect(wire).not.toContain('CANARYPYTHONCODE');
    expect(wire).toContain('"interpreter_inline":true');
  });

  it('Grep on a credential-shaped path and pattern emits only the classes, never the path or pattern', () => {
    const wire = emitOne({
      session_id: 's1',
      hook_event_name: 'PreToolUse',
      tool_name: 'Grep',
      tool_input: { pattern: 'CANARY_SECRET_VALUE', path: '/home/CANARYUSER/.ssh/id_rsa' },
    });
    expect(wire).not.toContain('CANARY_SECRET_VALUE');
    expect(wire).not.toContain('CANARYUSER');
    expect(wire).toContain('"path_class":"ssh_key"');
    expect(wire).toContain('"search_class":"secrets_dir"');
  });

  it('Glob on a non-credential pattern emits no search_class', () => {
    const wire = emitOne({
      session_id: 's1',
      hook_event_name: 'PreToolUse',
      tool_name: 'Glob',
      tool_input: { pattern: '**/*.CANARYEXT', path: '/repo/CANARYPROJECT' },
    });
    expect(wire).not.toContain('CANARYEXT');
    expect(wire).not.toContain('CANARYPROJECT');
    expect(wire).not.toContain('search_class');
  });

  it('a setuid chmod on a canary script emits cap_class, never the script path', () => {
    const wire = emitOne({
      session_id: 's1',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'chmod u+s /opt/CANARYSCRIPT.sh' },
    });
    expect(wire).not.toContain('CANARYSCRIPT');
    expect(wire).toContain('"cap_class":"setuid"');
  });

  it('usermod joining a canary-named group emits group_class other, never the group name', () => {
    const wire = emitOne({
      session_id: 's1',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'usermod -aG CANARYGROUPNAME $USER' },
    });
    expect(wire).not.toContain('CANARYGROUPNAME');
    expect(wire).toContain('"group_class":"other"');
  });
});
