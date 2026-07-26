/**
 * opencode plugin harness — normalize opencode's in-process plugin hooks into the
 * shared HookEvent shape, so opencode reuses the same bodies-off emit pipeline
 * (emitHookEvent) as the Claude Code / Codex shell hooks. Locks the redaction
 * contract: tool NAMES + argument KEY names only (never values), unless the
 * operator opts in with AER_HOOK_RECORD_ARGS.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeOpencodeToolBefore,
  normalizeOpencodeToolAfter,
  normalizeOpencodeEvent,
  normalizeOpencodeMessage,
} from './opencode.js';

// A realistic assistant message.updated (bodies-off: the model/tokens live on the
// message; the actual prompt/completion TEXT arrives via message.part.updated).
function assistantMessage(over: Record<string, unknown> = {}): unknown {
  return {
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg_1',
        sessionID: 'ses_1',
        role: 'assistant',
        modelID: 'claude-sonnet-5',
        providerID: 'anthropic',
        time: { created: 1 },
        cost: 0,
        tokens: { input: 120, output: 45, reasoning: 0, cache: { read: 0, write: 0 } },
        ...over,
      },
    },
  };
}

describe('normalizeOpencodeToolBefore', () => {
  it('maps a tool.execute.before to a tool_start with arg KEY names only', () => {
    const ev = normalizeOpencodeToolBefore(
      { tool: 'bash', sessionID: 'ses_1', callID: 'call_1' },
      { args: { command: 'git commit -m "secret"', description: 'commit' } },
    );
    expect(ev.kind).toBe('tool_start');
    expect(ev.tool).toBe('bash');
    expect(ev.sessionRef).toBe('ses_1');
    expect(ev.argKeys).toEqual(['command', 'description']); // sorted key names
    // No argument VALUES leak into the normalized event.
    expect(JSON.stringify(ev)).not.toContain('secret');
  });

  it('tolerates a missing/partial payload without throwing', () => {
    expect(() => normalizeOpencodeToolBefore({}, {})).not.toThrow();
    const ev = normalizeOpencodeToolBefore({}, {});
    expect(ev.kind).toBe('tool_start');
    expect(ev.tool).toBeUndefined();
  });
});

describe('normalizeOpencodeToolAfter', () => {
  it('maps tool.execute.after to a successful tool_end by default', () => {
    const ev = normalizeOpencodeToolAfter(
      { tool: 'read', sessionID: 'ses_1', callID: 'call_1', args: { filePath: '/x' } },
      { title: 'read', output: 'file contents here', metadata: {} },
    );
    expect(ev.kind).toBe('tool_end');
    expect(ev.tool).toBe('read');
    expect(ev.ok).toBe(true);
    expect(ev.isError).toBe(false);
    // Result content never appears in the normalized event.
    expect(JSON.stringify(ev)).not.toContain('file contents here');
  });

  it('flags an error when the tool metadata signals one', () => {
    const ev = normalizeOpencodeToolAfter(
      { tool: 'bash', sessionID: 'ses_1', callID: 'call_2', args: {} },
      { title: 'bash', output: 'boom', metadata: { error: true } },
    );
    expect(ev.ok).toBe(false);
    expect(ev.isError).toBe(true);
  });
});

describe('normalizeOpencodeEvent', () => {
  it('maps session.created to session_start with the session id', () => {
    const ev = normalizeOpencodeEvent({ type: 'session.created', properties: { info: { id: 'ses_9' } } });
    expect(ev.kind).toBe('session_start');
    expect(ev.sessionRef).toBe('ses_9');
  });

  it('maps session.deleted to session_end (not session.idle, a mere turn boundary)', () => {
    const del = normalizeOpencodeEvent({ type: 'session.deleted', properties: { info: { id: 'ses_9' } } });
    expect(del.kind).toBe('session_end');
    expect(del.sessionRef).toBe('ses_9');

    const idle = normalizeOpencodeEvent({ type: 'session.idle', properties: { sessionID: 'ses_9' } });
    expect(idle.kind).toBe('other'); // idle is a turn boundary, not an end
  });

  it('drops unrelated events as other', () => {
    expect(normalizeOpencodeEvent({ type: 'lsp.updated', properties: {} }).kind).toBe('other');
    expect(normalizeOpencodeEvent({}).kind).toBe('other');
    expect(() => normalizeOpencodeEvent(null)).not.toThrow();
  });
});

describe('normalizeOpencodeMessage', () => {
  it('lifts model + token counts from an in-progress assistant message (not yet complete)', () => {
    const llm = normalizeOpencodeMessage(assistantMessage());
    expect(llm).not.toBeNull();
    expect(llm!.messageId).toBe('msg_1');
    expect(llm!.sessionRef).toBe('ses_1');
    expect(llm!.model).toBe('claude-sonnet-5');
    expect(llm!.provider).toBe('anthropic');
    expect(llm!.inputTokens).toBe(120);
    expect(llm!.outputTokens).toBe(45);
    expect(llm!.ok).toBe(true);
    expect(llm!.complete).toBe(false); // no time.completed / finish / error yet
  });

  it('marks complete when time.completed is set', () => {
    const llm = normalizeOpencodeMessage(assistantMessage({ time: { created: 1, completed: 2 }, finish: 'stop' }));
    expect(llm!.complete).toBe(true);
    expect(llm!.ok).toBe(true);
  });

  it('marks complete + not-ok when the message carries an error', () => {
    const llm = normalizeOpencodeMessage(assistantMessage({ error: { name: 'ProviderAuthError' } }));
    expect(llm!.complete).toBe(true);
    expect(llm!.ok).toBe(false);
  });

  it('never reads message content — only structured metadata', () => {
    // Even if a caller passed a content-bearing shape, the normalizer ignores it.
    const llm = normalizeOpencodeMessage(assistantMessage({ content: 'my SECRET reasoning' }));
    expect(JSON.stringify(llm)).not.toContain('SECRET');
  });

  it('returns null for user messages and non-message events', () => {
    expect(normalizeOpencodeMessage(assistantMessage({ role: 'user' }))).toBeNull();
    expect(normalizeOpencodeMessage({ type: 'session.idle', properties: { sessionID: 'ses_1' } })).toBeNull();
    expect(normalizeOpencodeMessage({})).toBeNull();
    expect(() => normalizeOpencodeMessage(null)).not.toThrow();
    expect(normalizeOpencodeMessage(null)).toBeNull();
  });

  it('drops malformed token counts rather than emitting garbage', () => {
    const llm = normalizeOpencodeMessage(assistantMessage({ tokens: { input: -5, output: 'lots' } }));
    expect(llm!.inputTokens).toBeUndefined();
    expect(llm!.outputTokens).toBeUndefined();
  });
});
