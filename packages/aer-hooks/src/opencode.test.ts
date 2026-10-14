/**
 * opencode plugin harness - normalize opencode's in-process plugin hooks into the
 * shared HookEvent shape, so opencode reuses the same bodies-off emit pipeline
 * (emitHookEvent) as the Claude Code / Codex shell hooks. Locks the redaction
 * contract: tool NAMES + argument KEY names only (never values), unless the
 * values never leave the machine.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeOpencodeToolBefore,
  normalizeOpencodeToolAfter,
  normalizeOpencodeEvent,
  normalizeOpencodeMessage,
  parseOpencodePermissionUpdated,
  parseOpencodePermissionReplied,
  mapOpencodePermissionResponse,
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

describe('opencode built-in tools reduce the way the shell hooks do', () => {
  const before = (tool: string, args: Record<string, unknown>) =>
    normalizeOpencodeToolBefore({ tool, sessionID: 's', callID: 'c' }, { args });

  it('reduces bash to its programs and hosts, never the command line', () => {
    const ev = before('bash', { command: 'cat notes.txt && curl -s https://example.com/p?token=SECRET_VALUE', description: 'SECRET_VALUE' });
    expect(ev.shapes).toEqual([
      { eventType: 'process.exec', payload: { command: 'cat', command_known: true } },
      { eventType: 'process.exec', payload: { command: 'curl', command_known: true } },
      { eventType: 'network.connect', payload: { host: 'example.com', source: 'shell', via: 'curl' } },
    ]);
    expect(JSON.stringify(ev)).not.toContain('SECRET_VALUE');
  });

  it('carries the via program through for opencode bash too (host provenance decision 9/parity)', () => {
    const ev = before('bash', { command: 'curl https://api.github.com && git clone https://github.com/foo/bar' });
    expect(ev.shapes).toEqual([
      { eventType: 'process.exec', payload: { command: 'curl', command_known: true } },
      { eventType: 'process.exec', payload: { command: 'git', command_known: true } },
      { eventType: 'network.connect', payload: { host: 'api.github.com', source: 'shell', via: 'curl' } },
      { eventType: 'network.connect', payload: { host: 'github.com', source: 'shell', via: 'git' } },
    ]);
  });

  it('records the path a file tool touched, never the content', () => {
    expect(before('read', { filePath: '/w/a.txt', offset: 1 }).shapes).toEqual([{ eventType: 'file.opened', payload: { path: '/w/a.txt' } }]);
    for (const tool of ['write', 'edit']) {
      const ev = before(tool, { filePath: '/w/b.txt', content: 'SECRET_VALUE', oldString: 'SECRET_VALUE', newString: 'SECRET_VALUE' });
      expect(ev.shapes).toEqual([{ eventType: 'file.written', payload: { path: '/w/b.txt' } }]);
      expect(JSON.stringify(ev)).not.toContain('SECRET_VALUE');
    }
  });

  it('records the host a fetch reached, never its path or query', () => {
    const ev = before('webfetch', { url: 'https://docs.example.org/private/SECRET_VALUE?q=SECRET_VALUE', format: 'text' });
    expect(ev.shapes).toEqual([{ eventType: 'network.connect', payload: { host: 'docs.example.org', scheme: 'https', source: 'fetch_tool' } }]);
    expect(JSON.stringify(ev)).not.toContain('SECRET_VALUE');
  });

  it('adds nothing for a tool it does not know, or arguments it cannot read', () => {
    expect(before('todowrite', { todos: [] }).shapes).toBeUndefined();
    expect(before('read', { path: 42 } as Record<string, unknown>).shapes).toBeUndefined();
    expect(normalizeOpencodeToolBefore({ tool: 'bash' }, { args: 'not an object' }).shapes).toBeUndefined();
  });

  it('reduces glob to a path/pattern classification only, never the raw pattern or path', () => {
    const ev = before('glob', { pattern: 'id_rsa', path: '/home/SECRET_VALUE/project', hidden: true, limit: 50 });
    expect(ev.shapes).toEqual([{ eventType: 'file.searched', payload: { search_class: 'ssh_key' } }]);
    expect(JSON.stringify(ev)).not.toContain('SECRET_VALUE');
  });

  it('reduces grep the same way, never the raw pattern, path or include filter', () => {
    const ev = before('grep', { pattern: 'token', path: '/home/SECRET_VALUE/.ssh/id_rsa', include: '*.ts' });
    expect(ev.shapes).toEqual([{ eventType: 'file.searched', payload: { path_class: 'ssh_key', search_class: 'token_cache' } }]);
    expect(JSON.stringify(ev)).not.toContain('SECRET_VALUE');
  });

  it('reduces apply_patch (opencode\'s patch tool) to the files its headers name, never the diff body', () => {
    const patchText = [
      '*** Begin Patch',
      '*** Update File: src/app.py',
      '@@ def greet():',
      '-print("SECRET_VALUE")',
      '+print("hello")',
      '*** Add File: new.txt',
      '+SECRET_VALUE',
      '*** End Patch',
    ].join('\n');
    const ev = before('apply_patch', { patchText });
    expect(ev.shapes).toEqual([
      { eventType: 'file.written', payload: { path: 'src/app.py' } },
      { eventType: 'file.written', payload: { path: 'new.txt' } },
    ]);
    expect(JSON.stringify(ev)).not.toContain('SECRET_VALUE');
  });

  it('never mistakes a patch CONTENT line for a file header, even one that looks like one', () => {
    // A `+`-prefixed line is content being added, not an operation header -
    // the header regex only matches an UNPREFIXED "*** ... File:" line.
    const patchText = [
      '*** Begin Patch',
      '*** Add File: notes.txt',
      '+*** Add File: /home/user/.ssh/id_rsa',
      '*** End Patch',
    ].join('\n');
    const ev = before('apply_patch', { patchText });
    expect(ev.shapes).toEqual([{ eventType: 'file.written', payload: { path: 'notes.txt' } }]);
    expect(JSON.stringify(ev)).not.toContain('id_rsa');
  });

  it('records how many files an opencode patch named once it exceeds the per-record cap', () => {
    const patchText = [
      '*** Begin Patch',
      ...Array.from({ length: 20 }, (_, i) => `*** Add File: f${i}.txt\n+line`),
      '*** End Patch',
    ].join('\n');
    const ev = before('apply_patch', { patchText });
    expect(ev.shapes).toHaveLength(16); // PATCH_FILE_CAP
    expect(ev.filesNamed).toBe(20);
  });

  it('declines to map task and todowrite: their only useful argument is free text', () => {
    // task's `prompt` is the instructions handed to the subagent; todowrite's
    // `todos[].content` is the todo item text. Neither has a safe reduction,
    // so both fall through to the generic {tool, arg_keys} shape untouched.
    const taskEv = before('task', { description: 'fix bug', prompt: 'Do SECRET_VALUE things', subagent_type: 'general' });
    expect(taskEv.shapes).toBeUndefined();
    expect(JSON.stringify(taskEv)).not.toContain('SECRET_VALUE');

    const todoEv = before('todowrite', { todos: [{ id: '1', content: 'SECRET_VALUE todo', status: 'pending' }] });
    expect(todoEv.shapes).toBeUndefined();
    expect(JSON.stringify(todoEv)).not.toContain('SECRET_VALUE');
  });

  it('marks every mapped event with the opencode harness', () => {
    expect(before('bash', { command: 'ls' }).meta).toEqual({ harness: 'opencode' });
    expect(normalizeOpencodeToolAfter({ tool: 'bash' }, {}).meta).toEqual({ harness: 'opencode' });
    expect(normalizeOpencodeEvent({ type: 'session.created', properties: { info: { id: 's' } } }).meta).toEqual({ harness: 'opencode' });
    expect(normalizeOpencodeEvent({ type: 'session.idle', properties: { sessionID: 's' } }).meta).toBeUndefined();
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

  it('never reads message content: only structured metadata', () => {
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

// Oversight markers: opencode's bus events. The pinned SDK's type
// declarations and a live run of the real binary disagree on field names
// (see opencode.ts); both shapes are tested below. Only the ids/response are
// ever read, never permission/patterns/metadata/type/title.
describe('parseOpencodePermissionUpdated', () => {
  it('reads the permission id, session id and call id off the type-declared permission.updated shape', () => {
    const u = parseOpencodePermissionUpdated({
      type: 'permission.updated',
      properties: {
        id: 'perm_1', type: 'bash', sessionID: 'ses_1', messageID: 'msg_1',
        callID: 'call_1', title: 'Run bash', metadata: {}, time: { created: 1 },
      },
    });
    expect(u).toEqual({ permissionId: 'perm_1', sessionRef: 'ses_1', callId: 'call_1' });
  });

  it('reads the permission id, session id and NESTED call id off the observed-live permission.asked shape', () => {
    const u = parseOpencodePermissionUpdated({
      type: 'permission.asked',
      properties: {
        id: 'per_1', sessionID: 'ses_1', permission: 'bash', patterns: ['ls'],
        metadata: { command: 'ls' }, always: ['ls *'], tool: { messageID: 'msg_1', callID: 'call_1' },
      },
    });
    expect(u).toEqual({ permissionId: 'per_1', sessionRef: 'ses_1', callId: 'call_1' });
  });

  it('omits callId when opencode does not send one, in either shape', () => {
    const updated = parseOpencodePermissionUpdated({
      type: 'permission.updated',
      properties: { id: 'perm_2', type: 'edit', sessionID: 'ses_1', messageID: 'msg_1', title: 't', metadata: {}, time: { created: 1 } },
    });
    expect(updated).toEqual({ permissionId: 'perm_2', sessionRef: 'ses_1' });

    const asked = parseOpencodePermissionUpdated({
      type: 'permission.asked',
      properties: { id: 'per_2', sessionID: 'ses_1', permission: 'edit', patterns: [], metadata: {}, tool: { messageID: 'msg_1' } },
    });
    expect(asked).toEqual({ permissionId: 'per_2', sessionRef: 'ses_1' });
  });

  it('returns null for unrelated events, or one missing an id', () => {
    expect(parseOpencodePermissionUpdated({ type: 'session.idle', properties: {} })).toBeNull();
    expect(parseOpencodePermissionUpdated({ type: 'permission.updated', properties: {} })).toBeNull();
    expect(parseOpencodePermissionUpdated({ type: 'permission.asked', properties: {} })).toBeNull();
    expect(parseOpencodePermissionUpdated(null)).toBeNull();
    expect(() => parseOpencodePermissionUpdated(null)).not.toThrow();
  });

  it('never carries permission, patterns, type, title or metadata through, only the ids', () => {
    const updated = parseOpencodePermissionUpdated({
      type: 'permission.updated',
      properties: {
        id: 'perm_1', type: 'bash', sessionID: 'ses_1', messageID: 'msg_1', callID: 'call_1',
        pattern: 'rm -rf SECRET', title: 'SECRET-TITLE', metadata: { arg: 'SECRET' }, time: { created: 1 },
      },
    });
    expect(JSON.stringify(updated)).not.toContain('SECRET');

    const asked = parseOpencodePermissionUpdated({
      type: 'permission.asked',
      properties: {
        id: 'per_1', sessionID: 'ses_1', permission: 'bash', patterns: ['rm -rf SECRET'],
        metadata: { command: 'SECRET' }, always: ['SECRET'], tool: { messageID: 'msg_1', callID: 'call_1' },
      },
    });
    expect(JSON.stringify(asked)).not.toContain('SECRET');
  });
});

describe('parseOpencodePermissionReplied', () => {
  it('reads the permission id, session id and response off the type-declared permissionID/response shape', () => {
    const r = parseOpencodePermissionReplied({
      type: 'permission.replied',
      properties: { sessionID: 'ses_1', permissionID: 'perm_1', response: 'once' },
    });
    expect(r).toEqual({ permissionId: 'perm_1', sessionRef: 'ses_1', response: 'once' });
  });

  it('reads the permission id, session id and response off the observed-live requestID/reply shape', () => {
    const r = parseOpencodePermissionReplied({
      type: 'permission.replied',
      properties: { sessionID: 'ses_1', requestID: 'per_1', reply: 'reject' },
    });
    expect(r).toEqual({ permissionId: 'per_1', sessionRef: 'ses_1', response: 'reject' });
  });

  it('prefers requestID/reply over permissionID/response when (implausibly) both are present', () => {
    const r = parseOpencodePermissionReplied({
      type: 'permission.replied',
      properties: { sessionID: 'ses_1', requestID: 'live_id', reply: 'once', permissionID: 'old_id', response: 'reject' },
    });
    expect(r).toEqual({ permissionId: 'live_id', sessionRef: 'ses_1', response: 'once' });
  });

  it('returns null for unrelated events, or one missing a permission id/response in either shape', () => {
    expect(parseOpencodePermissionReplied({ type: 'permission.updated', properties: {} })).toBeNull();
    expect(parseOpencodePermissionReplied({ type: 'permission.replied', properties: { permissionID: 'perm_1' } })).toBeNull();
    expect(parseOpencodePermissionReplied({ type: 'permission.replied', properties: { requestID: 'per_1' } })).toBeNull();
    expect(parseOpencodePermissionReplied({ type: 'permission.replied', properties: { response: 'once' } })).toBeNull();
    expect(parseOpencodePermissionReplied(null)).toBeNull();
  });
});

describe('mapOpencodePermissionResponse', () => {
  it('maps once/always to allowed and reject to denied', () => {
    expect(mapOpencodePermissionResponse('once')).toBe('allowed');
    expect(mapOpencodePermissionResponse('always')).toBe('allowed');
    expect(mapOpencodePermissionResponse('reject')).toBe('denied');
  });

  it('drops an unrecognised response rather than guessing a decision', () => {
    expect(mapOpencodePermissionResponse('whatever')).toBeUndefined();
  });
});
