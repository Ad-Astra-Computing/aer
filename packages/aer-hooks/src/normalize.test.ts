import { describe, it, expect } from 'vitest';
import {
  normalizeClaudeCode,
  normalizeCodex,
  detectHarness,
  normalize,
  toolCallDigest,
} from './normalize.js';

// Real Claude Code payload shapes (https://code.claude.com/docs/en/hooks).
const ccPreToolUse = {
  session_id: 'abc123',
  transcript_path: '/x/t.jsonl',
  cwd: '/home/user/proj',
  permission_mode: 'default',
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'npm test' },
};
const ccPostToolUse = {
  session_id: 'abc123',
  hook_event_name: 'PostToolUse',
  tool_name: 'Edit',
  tool_input: { file_path: '/a.ts', old_string: 'x', new_string: 'y' },
  tool_response: { filePath: '/a.ts' },
};
const ccPostToolUseError = {
  session_id: 'abc123',
  hook_event_name: 'PostToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'false' },
  tool_response: { is_error: true, stderr: 'boom' },
};
const ccSessionStart = {
  session_id: 'abc123',
  hook_event_name: 'SessionStart',
  source: 'startup',
  model: 'claude-sonnet-5',
};
const ccStop = {
  session_id: 'abc123',
  hook_event_name: 'Stop',
  last_assistant_message: 'all done',
};
const ccPrompt = {
  session_id: 'abc123',
  hook_event_name: 'UserPromptSubmit',
  prompt: 'do the thing',
};

// Real Codex CLI payload shapes (https://learn.chatgpt.com/docs/hooks). Same field
// names as Claude Code plus turn_id / tool_use_id / model.
const codexPreToolUse = {
  session_id: 'sess-9',
  hook_event_name: 'PreToolUse',
  cwd: '/repo',
  model: 'gpt-5-codex',
  turn_id: 'turn-1',
  tool_name: 'Bash',
  tool_use_id: 'tu-1',
  tool_input: { command: 'ls -la' },
};
const codexPostToolUse = {
  session_id: 'sess-9',
  hook_event_name: 'PostToolUse',
  model: 'gpt-5-codex',
  turn_id: 'turn-1',
  tool_name: 'apply_patch',
  tool_use_id: 'tu-2',
  tool_input: { command: 'diff' },
  tool_response: { output: 'ok' },
};

describe('normalizeClaudeCode', () => {
  it('maps PreToolUse to tool_start with tool + arg keys', () => {
    const e = normalizeClaudeCode(ccPreToolUse);
    expect(e.kind).toBe('tool_start');
    expect(e.tool).toBe('Bash');
    expect(e.argKeys).toEqual(['command']);
    expect(e.sessionRef).toBe('abc123');
  });

  it('maps PostToolUse (success) to tool_end ok=true', () => {
    const e = normalizeClaudeCode(ccPostToolUse);
    expect(e.kind).toBe('tool_end');
    expect(e.tool).toBe('Edit');
    expect(e.argKeys).toEqual(['file_path', 'new_string', 'old_string']);
    expect(e.ok).toBe(true);
    expect(e.isError).toBe(false);
  });

  it('maps PostToolUse (is_error) to tool_end ok=false', () => {
    const e = normalizeClaudeCode(ccPostToolUseError);
    expect(e.kind).toBe('tool_end');
    expect(e.ok).toBe(false);
    expect(e.isError).toBe(true);
  });

  it('maps SessionStart / Stop / UserPromptSubmit', () => {
    expect(normalizeClaudeCode(ccSessionStart).kind).toBe('session_start');
    expect(normalizeClaudeCode(ccPrompt).kind).toBe('turn_start');
    // Stop is per TURN. It only means the run ended for a registration that
    // predates SessionEnd, which is exactly what lifecycle 1 is.
    expect(normalizeClaudeCode(ccStop, 1).kind).toBe('session_end');
    expect(normalizeClaudeCode(ccStop, 2).kind).toBe('turn_end');
    expect(normalizeClaudeCode({ hook_event_name: 'SessionEnd', reason: 'clear' }, 2).kind)
      .toBe('session_end');
  });

  it('yields kind=other for an unknown event and tolerates garbage', () => {
    expect(normalizeClaudeCode({ hook_event_name: 'Weird' }).kind).toBe('other');
    expect(normalizeClaudeCode(null).kind).toBe('other');
    expect(normalizeClaudeCode(42).kind).toBe('other');
    expect(normalizeClaudeCode({}).kind).toBe('other');
  });

  it('carries transcript_path for locating llm usage, never as identifier-shaped meta', () => {
    const e = normalizeClaudeCode(ccPreToolUse);
    expect(e.transcriptPath).toBe('/x/t.jsonl');
    // Never lands in meta: meta only ever holds ingest-allowlisted values.
    expect(e.meta).not.toHaveProperty('transcript_path');
    expect(e.meta).not.toHaveProperty('transcriptPath');
  });

  it('leaves transcriptPath undefined when the payload has none', () => {
    expect(normalizeClaudeCode(ccPostToolUse).transcriptPath).toBeUndefined();
  });
});

describe('redaction', () => {
  it('never surfaces argument values by default, only keys', () => {
    const e = normalizeClaudeCode(ccPreToolUse);
    expect(e.argKeys).toEqual(['command']);
    // the value 'npm test' must not appear anywhere on the event
    expect(JSON.stringify(e)).not.toContain('npm test');
  });

  it('keeps argument values out of the event, with no opt-in to change that', () => {
    const e = normalizeClaudeCode(ccPreToolUse);
    expect(e.argKeys).toEqual(['command']);
    expect(JSON.stringify(e)).not.toContain('npm test');
  });
});

describe('normalizeCodex', () => {
  it('maps PreToolUse to tool_start', () => {
    const e = normalizeCodex(codexPreToolUse);
    expect(e.kind).toBe('tool_start');
    expect(e.tool).toBe('Bash');
    expect(e.argKeys).toEqual(['command']);
    expect(e.sessionRef).toBe('sess-9');
  });

  it('maps PostToolUse to tool_end ok=true', () => {
    const e = normalizeCodex(codexPostToolUse);
    expect(e.kind).toBe('tool_end');
    expect(e.tool).toBe('apply_patch');
    expect(e.ok).toBe(true);
  });

  it('records the files a real apply_patch call writes, against the session cwd', () => {
    // The payload Codex 0.158 sends for apply_patch: the whole patch rides in
    // tool_input.command, file content included.
    const e = normalizeCodex({
      session_id: 'sess-9',
      turn_id: 't-1',
      cwd: '/work/proj',
      hook_event_name: 'PreToolUse',
      model: 'gpt-5.5',
      tool_name: 'apply_patch',
      tool_input: { command: '*** Begin Patch\n*** Add File: notes.txt\n+SECRET CONTENT\n*** End Patch\n' },
      tool_use_id: 'call_2',
    }, 2);
    expect(e.tool).toBe('apply_patch');
    expect(e.argKeys).toEqual(['command']);
    expect(e.shapes).toEqual([{ eventType: 'file.written', payload: { path: '/work/proj/notes.txt' } }]);
    expect(JSON.stringify(e)).not.toContain('SECRET');
  });

  it('says how many files a patch named when it names more than are recorded', () => {
    const lines = ['*** Begin Patch'];
    for (let i = 0; i < 20; i++) lines.push(`*** Add File: f${i}.txt`, '+SECRET');
    lines.push('*** End Patch');
    const big = normalizeCodex({ hook_event_name: 'PreToolUse', cwd: '/w', turn_id: 't', tool_name: 'apply_patch', tool_input: { command: lines.join('\n') } }, 2);
    expect(big.shapes?.length).toBe(16);
    expect(big.filesNamed).toBe(20);
    const small = normalizeCodex({ hook_event_name: 'PreToolUse', cwd: '/w', turn_id: 't', tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Add File: a\n+x\n*** End Patch' } }, 2);
    expect(small.filesNamed).toBeUndefined();
  });

  it('falls back to `arguments` when tool_input is absent', () => {
    const e = normalizeCodex(
      { hook_event_name: 'PreToolUse', tool_name: 'x', arguments: { a: 1, b: 2 } },
      {},
    );
    expect(e.argKeys).toEqual(['a', 'b']);
  });
});

describe('detectHarness', () => {
  it('detects codex from turn_id or tool_use_id', () => {
    expect(detectHarness(codexPreToolUse)).toBe('codex');
    expect(detectHarness({ hook_event_name: 'PostToolUse', tool_use_id: 't' })).toBe('codex');
    expect(detectHarness({ hook_event_name: 'Stop', turn_id: 't' })).toBe('codex');
  });

  it('detects claude-code from a bare hook_event_name', () => {
    expect(detectHarness(ccPreToolUse)).toBe('claude-code');
    expect(detectHarness(ccStop)).toBe('claude-code');
  });

  it('defaults to claude-code on garbage', () => {
    expect(detectHarness(null)).toBe('claude-code');
    expect(detectHarness({})).toBe('claude-code');
  });
});

// Oversight markers (P0-1): the local content digest that lets PermissionRequest
// (which drops tool_use_id on this Claude Code build, per the probe log) be
// matched back to the PreToolUse call it belongs to, by content, never by
// queue position.
describe('toolCallDigest / callDigest', () => {
  it('is the same digest for byte-identical tool_name + tool_input (PreToolUse then PermissionRequest)', () => {
    const preToolUse = normalizeClaudeCode({ ...ccPreToolUse, hook_event_name: 'PreToolUse' });
    const permissionRequest = normalizeClaudeCode({
      session_id: 'abc123', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm test' },
    });
    expect(preToolUse.callDigest).toBeDefined();
    expect(permissionRequest.callDigest).toBe(preToolUse.callDigest);
  });

  it('differs when tool_input differs', () => {
    const a = normalizeClaudeCode({ ...ccPreToolUse, tool_input: { command: 'npm test' } });
    const b = normalizeClaudeCode({ ...ccPreToolUse, tool_input: { command: 'npm run build' } });
    expect(a.callDigest).not.toBe(b.callDigest);
  });

  it('is independent of key order (canonical JSON, not raw bytes)', () => {
    const a = toolCallDigest('Edit', { a: 1, b: 2 });
    const b = toolCallDigest('Edit', { b: 2, a: 1 });
    expect(a).toBe(b);
  });

  it('differs by tool name alone', () => {
    expect(toolCallDigest('Bash', { x: 1 })).not.toBe(toolCallDigest('Read', { x: 1 }));
  });

  it('is absent when the payload names no tool (nothing to digest)', () => {
    expect(normalizeClaudeCode({ session_id: 's', hook_event_name: 'PermissionRequest' }).callDigest).toBeUndefined();
  });
});

describe('permissionHook', () => {
  it('maps PermissionRequest and PermissionDenied distinctly, nothing else', () => {
    expect(normalizeClaudeCode({ session_id: 's', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: {} }).permissionHook).toBe('request');
    expect(normalizeClaudeCode({ session_id: 's', hook_event_name: 'PermissionDenied', tool_name: 'Bash', tool_input: {} }).permissionHook).toBe('denied');
    expect(normalizeClaudeCode(ccPreToolUse).permissionHook).toBeUndefined();
  });

  it('is set the same way for Codex', () => {
    expect(normalizeCodex({ session_id: 's', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: {} }).permissionHook).toBe('request');
  });
});

describe("commonMeta carries tool_use_id on kind === 'permission' when the harness sends one", () => {
  it('Codex PermissionRequest with tool_use_id', () => {
    const e = normalizeCodex({ session_id: 's', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_use_id: 'tu-9', tool_input: {} });
    expect(e.meta?.['tool_use_id']).toBe('tu-9');
  });

  it("Claude Code's PermissionRequest carries no tool_use_id on this build (probed): meta omits it", () => {
    const e = normalizeClaudeCode({ session_id: 's', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: {} });
    expect(e.meta?.['tool_use_id']).toBeUndefined();
  });
});

describe('normalize (dispatch)', () => {
  it('honors an explicit harness override', () => {
    // codex payload but forced through the claude path still works (shared mapping)
    const e = normalize(codexPreToolUse, 'claude-code', {});
    expect(e.kind).toBe('tool_start');
  });

  it('auto-detects when no harness is given', () => {
    expect(normalize(codexPreToolUse, undefined, {}).kind).toBe('tool_start');
    expect(normalize(ccStop, undefined, {}).kind).toBe('session_end');
  });
});
