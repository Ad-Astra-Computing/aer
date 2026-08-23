import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import { installHttpPatch } from './http.js';
import type { CollectorEvent } from '../session.js';
import { createAttestor, type Attestor } from '../attestor.js';
import type { EgressEnforcement, EgressOnUnavailable } from '../config.js';

let server: http.Server;
let port: number;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/chunked') {
      // No Content-Length: multiple writes force Transfer-Encoding: chunked.
      res.statusCode = 200;
      res.write('a');
      res.end('b');
      return;
    }
    res.statusCode = 200;
    res.end('ok'); // node sets Content-Length: 2 automatically for a single end()
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

afterEach(() => {
  const g = globalThis as Record<symbol, unknown>;
  delete g[Symbol.for('adastra.aer.patched.http')];
});

function withCapture() {
  const events: CollectorEvent[] = [];
  return { capture: (e: CollectorEvent) => events.push(e), events };
}

function get(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
  });
}

describe('installHttpPatch', () => {
  it('emits http.requested + http.completed around a node:http request', async () => {
    const { capture, events } = withCapture();
    const uninstall = installHttpPatch(capture);
    const status = await get('/hello?token=secret');
    expect(status).toBe(200);

    const req = events.find((e) => e.event_type === 'http.requested');
    const done = events.find((e) => e.event_type === 'http.completed');
    expect(req?.payload).toMatchObject({ host: `127.0.0.1:${port}`, method: 'GET' });
    expect(String(req?.payload['path_redacted'])).toBe('/hello?<redacted>');
    expect(done?.payload).toMatchObject({ status: 200 });
    uninstall();
  });

  it('captures response_bytes from a Content-Length header', async () => {
    const { capture, events } = withCapture();
    const uninstall = installHttpPatch(capture);
    const status = await get('/hello');
    expect(status).toBe(200);
    const done = events.find((e) => e.event_type === 'http.completed');
    expect(done?.payload['response_bytes']).toBe(2);
    uninstall();
  });

  it('omits response_bytes for a chunked response with no Content-Length', async () => {
    const { capture, events } = withCapture();
    const uninstall = installHttpPatch(capture);
    const status = await get('/chunked');
    expect(status).toBe(200);
    const done = events.find((e) => e.event_type === 'http.completed');
    expect('response_bytes' in (done?.payload ?? {})).toBe(false);
    uninstall();
  });

  it('emits an error completion when the connection fails', async () => {
    const { capture, events } = withCapture();
    const uninstall = installHttpPatch(capture);
    await new Promise<void>((resolve) => {
      // port 1 is privileged/closed - connection refused
      const req = http.get({ host: '127.0.0.1', port: 1, path: '/' }, (res) => { res.resume(); resolve(); });
      req.on('error', () => resolve());
    });
    const done = events.find((e) => e.event_type === 'http.completed');
    expect(done?.payload['error']).toBe(true);
    uninstall();
  });

  it('is idempotent and restores the original on uninstall', async () => {
    const original = http.request;
    const { capture } = withCapture();
    const u1 = installHttpPatch(capture);
    const u2 = installHttpPatch(capture);
    expect(http.request).not.toBe(original);
    u2(); u1();
    expect(http.request).toBe(original);
  });

  it('never breaks the request if capture throws', async () => {
    const uninstall = installHttpPatch(() => { throw new Error('boom'); });
    const status = await get('/x');
    expect(status).toBe(200);
    uninstall();
  });
});

/** Real createAttestor wired to a fixed peek/await token (defaults enforcement 'off'). */
function fakeAttestor(opts: {
  host: string;
  audience?: string;
  token: string | null;
  scopes?: string[];
  enforcement?: EgressEnforcement;
  onUnavailable?: EgressOnUnavailable;
  dpop?: boolean;
}): Attestor {
  const resource = {
    host: opts.host,
    audience: opts.audience ?? 'mcp://aud',
    scopes: opts.scopes ?? [],
    enforcement: opts.enforcement ?? ('off' as const),
    onUnavailable: opts.onUnavailable ?? ('fail_closed' as const),
    dpop: opts.dpop ?? false,
  };
  return createAttestor({
    resources: [resource],
    getAttestationFor: async () => opts.token,
    peekAttestationFor: () => opts.token,
  });
}

// Stub a module's request/get so the patch captures them as "originals"; the
// stub records the args it's called with (after injection) without real I/O.
function stubModule(mod: { request: unknown; get: unknown }): { calls: unknown[][]; restore: () => void } {
  const calls: unknown[][] = [];
  const origReq = mod.request;
  const origGet = mod.get;
  const fake = function fakeRequest(this: unknown, ...args: unknown[]): EventEmitter {
    calls.push(args);
    return new EventEmitter();
  };
  mod.request = fake;
  mod.get = fake;
  return { calls, restore: () => { mod.request = origReq; mod.get = origGet; } };
}

function injectedHeader(calls: unknown[][]): string | null {
  const opts = calls[0]?.find((a) => a && typeof a === 'object' && !(a instanceof URL)) as
    | { headers?: Record<string, string> }
    | undefined;
  const headers = opts?.headers ?? {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'x-aer-attestation') return v;
  }
  return null;
}

describe('installHttpPatch attestation injection', () => {
  afterEach(() => {
    const g = globalThis as Record<symbol, unknown>;
    delete g[Symbol.for('adastra.aer.patched.http')];
  });

  it('injects X-AER-Attestation into an https request to a protected host', () => {
    const stub = stubModule(https);
    const att = fakeAttestor({ host: 'mcp.internal', token: 'jwt-1' });
    const uninstall = installHttpPatch(() => {}, att);

    https.request({ host: 'mcp.internal', path: '/tools', method: 'POST' });

    expect(injectedHeader(stub.calls)).toBe('jwt-1');
    expect(att.stats.injected).toBe(1);
    uninstall();
    stub.restore();
  });

  it('does NOT inject over plain node:http (TLS required)', () => {
    const stub = stubModule(http);
    const att = fakeAttestor({ host: 'mcp.internal', token: 'jwt-1' });
    const uninstall = installHttpPatch(() => {}, att);

    http.request({ host: 'mcp.internal', path: '/tools' });

    expect(injectedHeader(stub.calls)).toBeNull();
    expect(att.stats.injected).toBe(0);
    uninstall();
    stub.restore();
  });

  it('does NOT inject for an https host that is not protected', () => {
    const stub = stubModule(https);
    const att = fakeAttestor({ host: 'mcp.internal', token: 'jwt-1' });
    const uninstall = installHttpPatch(() => {}, att);

    https.request({ host: 'api.openai.com', path: '/v1/chat' });

    expect(injectedHeader(stub.calls)).toBeNull();
    expect(att.stats.injected).toBe(0);
    uninstall();
    stub.restore();
  });

  it('injects without a token => no header, request still dispatched (fail-closed)', () => {
    const stub = stubModule(https);
    const att = fakeAttestor({ host: 'mcp.internal', token: null });
    const uninstall = installHttpPatch(() => {}, att);

    https.request({ host: 'mcp.internal', path: '/x' });

    expect(stub.calls).toHaveLength(1); // request still went through
    expect(injectedHeader(stub.calls)).toBeNull();
    expect(att.stats.injected).toBe(0);
    uninstall();
    stub.restore();
  });

  it('does NOT overwrite a caller-supplied X-AER-Attestation header', () => {
    const stub = stubModule(https);
    const att = fakeAttestor({ host: 'mcp.internal', token: 'jwt-mine' });
    const uninstall = installHttpPatch(() => {}, att);

    https.request({ host: 'mcp.internal', path: '/x', headers: { 'X-AER-Attestation': 'caller-token' } });

    expect(injectedHeader(stub.calls)).toBe('caller-token');
    expect(att.stats.injected).toBe(0);
    uninstall();
    stub.restore();
  });

  it('no attestor => never injects', () => {
    const stub = stubModule(https);
    const uninstall = installHttpPatch(() => {});
    https.request({ host: 'mcp.internal', path: '/x' });
    expect(injectedHeader(stub.calls)).toBeNull();
    uninstall();
    stub.restore();
  });

  it('follows options.hostname (not the URL) when both are present', () => {
    // Node merges (url, options) with options winning - the socket connects to
    // options.hostname, so the token gate must too.
    const stub = stubModule(https);
    const att = fakeAttestor({ host: 'mcp.internal', token: 'jwt-1' });
    const uninstall = installHttpPatch(() => {}, att);

    // URL says a non-protected host, options redirects to the protected one.
    https.request(new URL('https://api.openai.com/v1'), { hostname: 'mcp.internal', path: '/x' });

    expect(injectedHeader(stub.calls)).toBe('jwt-1');
    uninstall();
    stub.restore();
  });

  it('does NOT inject when the URL is protected but options.hostname points elsewhere', () => {
    const stub = stubModule(https);
    const att = fakeAttestor({ host: 'mcp.internal', token: 'jwt-1' });
    const uninstall = installHttpPatch(() => {}, att);

    // URL is the protected host, but the real connection goes to evil.example.
    https.request(new URL('https://mcp.internal/x'), { hostname: 'evil.example' });

    expect(injectedHeader(stub.calls)).toBeNull(); // no token leak to the real destination
    uninstall();
    stub.restore();
  });
});

describe('installHttpPatch egress enforcement (M2)', () => {
  afterEach(() => {
    const g = globalThis as Record<symbol, unknown>;
    delete g[Symbol.for('adastra.aer.patched.http')];
  });

  const tokenWithScopes = (scp: string[]) => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `h.${b64({ scp })}.s`;
  };
  const errorOf = (req: http.ClientRequest): Promise<NodeJS.ErrnoException> =>
    new Promise((resolve) => req.on('error', (e) => resolve(e as NodeJS.ErrnoException)));

  it('block + cold cache (no token): never opens the socket, surfaces E_AER_EGRESS_BLOCKED', async () => {
    const stub = stubModule(https);
    const { capture, events } = withCapture();
    const att = fakeAttestor({ host: 'mcp.internal', token: null, enforcement: 'block' });
    const uninstall = installHttpPatch(capture, att);

    const req = https.request({ host: 'mcp.internal', path: '/x' });
    req.end();
    const err = await errorOf(req);

    expect(err.code).toBe('E_AER_EGRESS_BLOCKED');
    expect(stub.calls).toHaveLength(0); // original request fn never called
    expect(events.map((e) => e.event_type)).toContain('egress.blocked');
    expect(att.stats.egress_blocked).toBe(1);
    uninstall();
    stub.restore();
  });

  it('block + token missing required scope: blocks (insufficient_scope), no socket', async () => {
    const stub = stubModule(https);
    const { capture } = withCapture();
    const att = fakeAttestor({ host: 'mcp.internal', token: tokenWithScopes(['read']), enforcement: 'block', scopes: ['write'] });
    const uninstall = installHttpPatch(capture, att);

    const req = https.request({ host: 'mcp.internal', path: '/x' });
    req.end();
    const err = await errorOf(req);

    expect(err.code).toBe('E_AER_EGRESS_BLOCKED');
    expect(stub.calls).toHaveLength(0);
    expect(att.stats.egress_insufficient_scope).toBe(1);
    uninstall();
    stub.restore();
  });

  it('block + valid cached token covering scopes: allows + injects', () => {
    const stub = stubModule(https);
    const token = tokenWithScopes(['read']);
    const att = fakeAttestor({ host: 'mcp.internal', token, enforcement: 'block', scopes: ['read'] });
    const uninstall = installHttpPatch(() => {}, att);

    https.request({ host: 'mcp.internal', path: '/x' });

    expect(stub.calls).toHaveLength(1);
    expect(injectedHeader(stub.calls)).toBe(token);
    uninstall();
    stub.restore();
  });

  it('report + no token: dispatches the request and emits egress.would_block', () => {
    const stub = stubModule(https);
    const { capture, events } = withCapture();
    const att = fakeAttestor({ host: 'mcp.internal', token: null, enforcement: 'report' });
    const uninstall = installHttpPatch(capture, att);

    https.request({ host: 'mcp.internal', path: '/x' });

    expect(stub.calls).toHaveLength(1); // request still dispatched
    expect(events.map((e) => e.event_type)).toContain('egress.would_block');
    expect(att.stats.egress_would_block).toBe(1);
    uninstall();
    stub.restore();
  });

  it('block + fail_open + no token: dispatches the request (availability over strictness)', () => {
    const stub = stubModule(https);
    const att = fakeAttestor({ host: 'mcp.internal', token: null, enforcement: 'block', onUnavailable: 'fail_open' });
    const uninstall = installHttpPatch(() => {}, att);

    https.request({ host: 'mcp.internal', path: '/x' });

    expect(stub.calls).toHaveLength(1);
    expect(att.stats.egress_unavailable_fail_open).toBe(1);
    uninstall();
    stub.restore();
  });

  it('block mode leaves a non-protected host untouched', () => {
    const stub = stubModule(https);
    const att = fakeAttestor({ host: 'mcp.internal', token: null, enforcement: 'block' });
    const uninstall = installHttpPatch(() => {}, att);

    https.request({ host: 'api.openai.com', path: '/v1/chat' });

    expect(stub.calls).toHaveLength(1);
    uninstall();
    stub.restore();
  });
});

describe('installHttpPatch DPoP injection (M3)', () => {
  afterEach(() => {
    const g = globalThis as Record<symbol, unknown>;
    delete g[Symbol.for('adastra.aer.patched.http')];
  });

  const dpopHeader = (calls: unknown[][]): string | null => {
    const opts = calls[0]?.find((a) => a && typeof a === 'object' && !(a instanceof URL)) as { headers?: Record<string, string> } | undefined;
    for (const [k, v] of Object.entries(opts?.headers ?? {})) if (k.toLowerCase() === 'dpop') return v;
    return null;
  };

  it('injects a DPoP header (htu query-stripped) alongside the token for a dpop resource', () => {
    const stub = stubModule(https);
    const att = createAttestor({
      resources: [{ host: 'mcp.internal', audience: 'mcp://aud', scopes: [], enforcement: 'off', onUnavailable: 'fail_closed', dpop: true }],
      getAttestationFor: async () => 'jwt-1',
      peekAttestationFor: () => 'jwt-1',
      dpopProofFor: (m, u, t) => `proof:${m}:${u}:${t}`,
    });
    const uninstall = installHttpPatch(() => {}, att);

    https.request({ host: 'mcp.internal', path: '/tools?x=1', method: 'POST' });

    expect(injectedHeader(stub.calls)).toBe('jwt-1');
    expect(dpopHeader(stub.calls)).toBe('proof:POST:https://mcp.internal/tools:jwt-1'); // query stripped from htu
    uninstall();
    stub.restore();
  });

  it('does not add a DPoP header for a non-dpop resource', () => {
    const stub = stubModule(https);
    const att = createAttestor({
      resources: [{ host: 'mcp.internal', audience: 'mcp://aud', scopes: [], enforcement: 'off', onUnavailable: 'fail_closed', dpop: false }],
      getAttestationFor: async () => 'jwt-1',
      peekAttestationFor: () => 'jwt-1',
      dpopProofFor: () => 'should-not-be-used',
    });
    const uninstall = installHttpPatch(() => {}, att);

    https.request({ host: 'mcp.internal', path: '/tools', method: 'POST' });

    expect(injectedHeader(stub.calls)).toBe('jwt-1');
    expect(dpopHeader(stub.calls)).toBeNull();
    uninstall();
    stub.restore();
  });
});
