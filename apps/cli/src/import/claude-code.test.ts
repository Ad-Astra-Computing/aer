/**
 * H4 - Claude Code transcript import (mapping module).
 *
 * The mapper turns a Claude Code session JSONL transcript into bodies-off AER
 * events on the CLIENT, so raw prompts / model output / tool arguments never
 * transit AER. This suite locks the bodies-off contract, the redaction rules,
 * deterministic ids (idempotent re-import) and never-throws robustness.
 */
import { describe, it, expect } from 'vitest';
import { EventSchema } from '@aer/schemas';
import { claudeCodeTranscriptToEvents } from './claude-code.js';

const SESSION = '01950000-0000-7000-8000-00000000cc01';
const CTX = { sessionId: SESSION, now: '2026-07-17T00:00:00.000Z' };

// A compact but representative slice of a real transcript: an assistant turn
// with model+usage that issues a Bash tool_use and a Write tool_use, then the
// user tool_result that closes the Bash call with an error.
const ASSISTANT = {
  type: 'assistant',
  uuid: 'a1',
  timestamp: '2026-07-17T10:00:00.000Z',
  message: {
    role: 'assistant',
    model: 'claude-opus-4-8',
    usage: { input_tokens: 12, output_tokens: 340, cache_read_input_tokens: 23000 },
    content: [
      { type: 'text', text: 'let me run the tests' },
      { type: 'tool_use', id: 'toolu_bash1', name: 'Bash', input: { command: 'git commit -m "secret message" && ./deploy.sh', description: 'commit' } },
      { type: 'tool_use', id: 'toolu_write1', name: 'Write', input: { file_path: '/home/user/app/src/secret.ts', content: 'API_KEY=sk-live-123' } },
      { type: 'tool_use', id: 'toolu_fetch1', name: 'WebFetch', input: { url: 'https://api.internal.example.com/v2/data?token=abc123', prompt: 'summarize' } },
    ],
  },
};
const TOOL_RESULT = {
  type: 'user',
  uuid: 'u1',
  timestamp: '2026-07-17T10:00:05.000Z',
  message: {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'toolu_bash1', is_error: true, content: 'fatal: nothing to commit' },
    ],
  },
};

describe('claudeCodeTranscriptToEvents', () => {
  it('emits schema-valid, source=import events for a realistic turn', () => {
    const { events } = claudeCodeTranscriptToEvents([ASSISTANT, TOOL_RESULT], CTX);
    expect(events.length).toBeGreaterThan(0);
    for (const ev of events) {
      // Every emitted event must pass the same schema the /events endpoint enforces.
      const parsed = EventSchema.safeParse(ev);
      expect(parsed.success, JSON.stringify(ev)).toBe(true);
      expect(ev.source_type).toBe('import');
      expect(ev.agent_session_id).toBe(SESSION);
    }
  });

  it('captures model + token counts as an llm.completed (metadata, not content)', () => {
    const { events } = claudeCodeTranscriptToEvents([ASSISTANT], CTX);
    const llm = events.find((e) => e.event_type === 'llm.completed');
    expect(llm).toBeDefined();
    expect(llm!.payload.model).toBe('claude-opus-4-8');
    expect(llm!.payload.provider).toBe('anthropic');
    expect(llm!.payload.input_tokens).toBe(12);
    expect(llm!.payload.output_tokens).toBe(340);
  });

  it('reduces a Bash command to the executable name only (never argv/secrets)', () => {
    const { events } = claudeCodeTranscriptToEvents([ASSISTANT], CTX);
    const proc = events.find((e) => e.event_type === 'process.exec');
    expect(proc).toBeDefined();
    expect(proc!.payload.command).toBe('git');
    // The full command line (which held a secret) must appear nowhere.
    const blob = JSON.stringify(events);
    expect(blob).not.toContain('secret message');
    expect(blob).not.toContain('deploy.sh');
  });

  it('captures a Write as file.written with the path, never the file content', () => {
    const { events } = claudeCodeTranscriptToEvents([ASSISTANT], CTX);
    const file = events.find((e) => e.event_type === 'file.written');
    expect(file).toBeDefined();
    expect(file!.payload.path).toBe('/home/user/app/src/secret.ts');
    expect(JSON.stringify(events)).not.toContain('sk-live-123');
  });

  it('maps WebFetch to http.requested with host only (no path/query/token)', () => {
    const { events } = claudeCodeTranscriptToEvents([ASSISTANT], CTX);
    const http = events.find((e) => e.event_type === 'http.requested');
    expect(http).toBeDefined();
    expect(http!.payload.host).toBe('api.internal.example.com');
    const blob = JSON.stringify(events);
    expect(blob).not.toContain('token=abc123');
    expect(blob).not.toContain('/v2/data');
  });

  it('closes a tool call from its tool_result with ok=false on error', () => {
    const { events } = claudeCodeTranscriptToEvents([ASSISTANT, TOOL_RESULT], CTX);
    const done = events.filter((e) => e.event_type === 'process.exit');
    expect(done.length).toBe(1);
    expect(done[0]!.payload.ok).toBe(false);
  });

  it('is deterministic + idempotent — same input yields identical event_ids', () => {
    const a = claudeCodeTranscriptToEvents([ASSISTANT, TOOL_RESULT], CTX).events;
    const b = claudeCodeTranscriptToEvents([ASSISTANT, TOOL_RESULT], CTX).events;
    expect(a.map((e) => e.event_id)).toEqual(b.map((e) => e.event_id));
    // ids are unique within the run
    expect(new Set(a.map((e) => e.event_id)).size).toBe(a.length);
  });

  it('never throws on malformed / partial entries and skips them', () => {
    const junk = [
      null, 42, 'nope', {}, { type: 'assistant' }, { type: 'assistant', message: {} },
      { type: 'assistant', message: { content: 'not-an-array' } },
      { type: 'file-history-snapshot', foo: 1 }, { type: 'user', message: { content: [] } },
    ];
    expect(() => claudeCodeTranscriptToEvents(junk as never[], CTX)).not.toThrow();
    const { events } = claudeCodeTranscriptToEvents(junk as never[], CTX);
    expect(Array.isArray(events)).toBe(true);
  });

  it('bounds the emitted event count and flags truncation', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      type: 'assistant', uuid: `a${i}`, timestamp: '2026-07-17T10:00:00.000Z',
      message: { role: 'assistant', model: 'claude-opus-4-8', usage: { input_tokens: 1, output_tokens: 1 }, content: [] },
    }));
    const { events, truncated } = claudeCodeTranscriptToEvents(many, { ...CTX, maxEvents: 10 });
    expect(events.length).toBe(10);
    expect(truncated).toBe(true);
  });
});
