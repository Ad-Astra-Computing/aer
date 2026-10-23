import { describe, it, expect, vi } from 'vitest';
import { openSession, type ApiBase } from './transport.js';

function api(fetchImpl: typeof fetch): ApiBase {
  return {
    base: { baseUrl: 'https://aer-api.example.com', apiKey: 'k', sourceType: 'wrapper' },
    fetch: fetchImpl,
  };
}

describe('openSession', () => {
  it('opens a session from a normal JSON response', async () => {
    const impl = vi.fn(async () => new Response(JSON.stringify({ id: 's1', ingest_token: 't1' }), { status: 200 })) as unknown as typeof fetch;
    const r = await openSession(api(impl), undefined, 1000);
    expect(r).toMatchObject({ opened: { id: 's1', ingestToken: 't1' } });
  });

  // CVE-2026-111497: fetch() decodes a Brotli body lazily on first read, and a
  // hostile server picks Content-Encoding regardless of what was requested.
  // The session API is an external server this process does not control the
  // bytes of, so a compressed response must never be read.
  it('refuses a compressed response without reading its body', async () => {
    let bodyRead = false;
    const res = new Response(JSON.stringify({ id: 's1', ingest_token: 't1' }), { status: 200, headers: { 'content-encoding': 'br' } });
    res.text = (async () => { bodyRead = true; return '{}'; }) as typeof res.text;
    const impl = vi.fn(async () => res) as unknown as typeof fetch;
    const r = await openSession(api(impl), undefined, 1000);
    expect(r).toMatchObject({ failed: { ok: false, error: 'compressed_response_br' } });
    expect(bodyRead).toBe(false);
  });
});
