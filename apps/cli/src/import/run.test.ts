/**
 * H4 - end-to-end transcript import runner. Stubs fetch to assert the create →
 * ingest → complete sequence, that only bodies-off events are POSTed, and that
 * the summary reflects the server's accepted/rejected + the generated aer_id.
 */
import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { runClaudeCodeImport } from './run.js';

const TENANT = '01950000-0000-7000-8000-0000000000t1';
const AGENT = '01950000-0000-7000-8000-0000000000a1';
const ENV = '01950000-0000-7000-8000-0000000000e1';
const SESSION = '01950000-0000-7000-8000-0000000000s1';
const AER = '01950000-0000-7000-8000-0000000000r1';

function transcriptStream(): Readable {
  const lines = [
    JSON.stringify({ type: 'assistant', uuid: 'a1', timestamp: '2026-07-17T10:00:00.000Z', message: {
      role: 'assistant', model: 'claude-opus-4-8', usage: { input_tokens: 5, output_tokens: 50 },
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls -la /secret/path' } }],
    } }),
    '',
    JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-07-17T10:00:01.000Z', message: {
      role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: false, content: 'ok' }],
    } }),
    'this-is-not-json',
  ];
  return Readable.from(lines.join('\n'));
}

describe('runClaudeCodeImport', () => {
  it('creates a session, POSTs bodies-off events, completes, and summarizes', async () => {
    const calls: Array<{ url: string; method: string; body: unknown; auth?: string }> = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const auth = (init?.headers as Record<string, string> | undefined)?.['authorization'];
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: u, method: init?.method ?? 'GET', body, auth });
      if (u.endsWith('/v1/sessions')) {
        return new Response(JSON.stringify({ agent_session_id: SESSION, ingest_token: 'ingest-token-abcdef, ok', status: 'running' }), { status: 201 });
      }
      if (u.endsWith(`/v1/sessions/${SESSION}/events`)) {
        const arr = body as unknown[];
        return new Response(JSON.stringify({ accepted: arr.length, rejected: 0 }), { status: 202 });
      }
      if (u.endsWith(`/v1/sessions/${SESSION}/complete`)) {
        return new Response(JSON.stringify({ aer_id: AER }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;

    const summary = await runClaudeCodeImport({
      stream: transcriptStream(),
      baseUrl: 'https://api.test/',
      apiKey: 'tenant-key',
      tenantId: TENANT, agentId: AGENT, environmentId: ENV,
      fetchImpl, now: () => new Date('2026-07-17T00:00:00.000Z'),
    });

    // Sequence: create (tenant key) → events (ingest token) → complete (ingest token).
    expect(calls[0]!.url).toBe('https://api.test/v1/sessions');
    expect(calls[0]!.auth).toBe('Bearer tenant-key');
    expect((calls[0]!.body as { tenant_id: string }).tenant_id).toBe(TENANT);
    const eventsCall = calls.find((c) => c.url.endsWith('/events'))!;
    expect(eventsCall.auth).toContain('ingest-token');
    const completeCall = calls.find((c) => c.url.endsWith('/complete'))!;
    expect(completeCall).toBeDefined();

    // Summary reflects the run.
    expect(summary.session_id).toBe(SESSION);
    expect(summary.aer_id).toBe(AER);
    expect(summary.entries_read).toBe(2); // the non-JSON line is skipped
    expect(summary.imported_events).toBeGreaterThan(0);
    expect(summary.accepted).toBe(summary.imported_events);

    // Bodies-off: the secret path argv must never appear in any POSTed event.
    const blob = JSON.stringify(calls.filter((c) => c.url.endsWith('/events')).map((c) => c.body));
    expect(blob).not.toContain('/secret/path');
    expect(blob).toContain('"command":"ls"');
  });

  it('throws a clear error when session creation fails', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 403 })) as unknown as typeof fetch;
    await expect(runClaudeCodeImport({
      stream: transcriptStream(), baseUrl: 'https://api.test', apiKey: 'k',
      tenantId: TENANT, agentId: AGENT, environmentId: ENV, fetchImpl,
    })).rejects.toThrow(/session create failed: 403/);
  });
});
