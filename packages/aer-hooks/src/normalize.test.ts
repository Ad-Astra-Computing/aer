import { describe, it, expect } from 'vitest';
import {
  normalizeClaudeCode,
  normalizeCodex,
  detectHarness,
  normalize,
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
    const e = normalizeClaudeCode(ccPreToolUse, {});
    expect(e.kind).toBe('tool_start');
    expect(e.tool).toBe('Bash');
    expect(e.argKeys).toEqual(['command']);
    expect(e.sessionRef).toBe('abc123');
  });

  it('maps PostToolUse (success) to tool_end ok=true', () => {
    const e = normalizeClaudeCode(ccPostToolUse, {});
    expect(e.kind).toBe('tool_end');
    expect(e.tool).toBe('Edit');
    expect(e.argKeys).toEqual(['file_path', 'new_string', 'old_string']);
    expect(e.ok).toBe(true);
    expect(e.isError).toBe(false);
  });

  it('maps PostToolUse (is_error) to tool_end ok=false', () => {
    const e = normalizeClaudeCode(ccPostToolUseError, {});
    expect(e.kind).toBe('tool_end');
    expect(e.ok).toBe(false);
    expect(e.isError).toBe(true);
  });

  it('maps SessionStart / Stop / UserPromptSubmit', () => {
    expect(normalizeClaudeCode(ccSessionStart, {}).kind).toBe('session_start');
    expect(normalizeClaudeCode(ccStop, {}).kind).toBe('session_end');
    expect(normalizeClaudeCode(ccPrompt, {}).kind).toBe('prompt');
  });

  it('yields kind=other for an unknown event and tolerates garbage', () => {
    expect(normalizeClaudeCode({ hook_event_name: 'Weird' }, {}).kind).toBe('other');
    expect(normalizeClaudeCode(null, {}).kind).toBe('other');
    expect(normalizeClaudeCode(42, {}).kind).toBe('other');
    expect(normalizeClaudeCode({}, {}).kind).toBe('other');
  });
});

describe('redaction', () => {
  it('never surfaces argument values by default, only keys', () => {
    const e = normalizeClaudeCode(ccPreToolUse, {});
    expect(e.argKeys).toEqual(['command']);
    // the value 'npm test' must not appear anywhere on the event
    expect(JSON.stringify(e)).not.toContain('npm test');
  });

  it('argKeys are the same regardless of the opt-in flag (values handled downstream)', () => {
    const off = normalizeClaudeCode(ccPreToolUse, {});
    const on = normalizeClaudeCode(ccPreToolUse, { AER_HOOK_RECORD_ARGS: '1' });
    expect(on.argKeys).toEqual(off.argKeys);
    expect(JSON.stringify(on)).not.toContain('npm test');
  });
});

describe('normalizeCodex', () => {
  it('maps PreToolUse to tool_start', () => {
    const e = normalizeCodex(codexPreToolUse, {});
    expect(e.kind).toBe('tool_start');
    expect(e.tool).toBe('Bash');
    expect(e.argKeys).toEqual(['command']);
    expect(e.sessionRef).toBe('sess-9');
  });

  it('maps PostToolUse to tool_end ok=true', () => {
    const e = normalizeCodex(codexPostToolUse, {});
    expect(e.kind).toBe('tool_end');
    expect(e.tool).toBe('apply_patch');
    expect(e.ok).toBe(true);
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
