// Patch node:http + node:https request/get -> http.requested / http.completed.
//
// Same rules as the fetch patch: idempotent, restores originals, never throws
// into the host. Completion is observed via the ClientRequest 'response' and
// 'error' events so we record status without touching bodies.

import http from 'node:http';
import https from 'node:https';
import { Writable } from 'node:stream';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { CollectorEvent } from '../session.js';
import type { Attestor } from '../attestor.js';
import { redactUrlPath, redactPathString } from '../redaction.js';
import { responseBytesField } from './response-size.js';

type Capture = (event: CollectorEvent) => void;

const ATTESTATION_HEADER = 'X-AER-Attestation';

const PATCHED = Symbol.for('adastra.aer.patched.http');

interface PatchSlot { [PATCHED]?: { restore: () => void } }

const noop = (): void => undefined;

type RequestFn = typeof http.request;

export function installHttpPatch(capture: Capture, attestor?: Attestor): () => void {
  const slot = globalThis as unknown as PatchSlot;
  if (slot[PATCHED]) return noop;

  const originals = {
    httpRequest: http.request,
    httpGet: http.get,
    httpsRequest: https.request,
    httpsGet: https.get,
  };

  const wrap = (original: RequestFn, moduleSecure: boolean): RequestFn =>
    function wrapped(this: unknown, ...args: unknown[]): ClientRequest {
      const meta = safeExtract(args);
      const start = Date.now();
      safeCapture(capture, {
        event_type: 'http.requested',
        payload: { host: meta.host, method: meta.method, path_redacted: meta.path },
      });
      // Attestation injection (HTTPS + configured protected hosts only). The
      // sync API can't await a mint, so we inject a cached token if present and
      // warm the cache otherwise (next request to this host is then covered).
      let callArgs = args;
      const secure = meta.secure ?? moduleSecure;
      if (attestor && secure && meta.host !== 'unknown') {
        const resource = attestor.resourceFor(meta.host);
        if (resource) {
          // Cached token only - the sync API cannot await a mint. A cold miss in
          // block mode therefore denies immediately (and warms for next time)
          // rather than opening the socket without a token.
          const token = attestor.peekToken(resource.audience, resource.scopes, resource.dpop);
          const decision = attestor.evaluateEgress(resource, token);
          if (!decision.allow) {
            safeCapture(capture, {
              event_type: 'egress.blocked',
              payload: { host: meta.host, audience: resource.audience, reason: decision.reason ?? 'blocked' },
            });
            return syntheticBlockedRequest(decision.reason ?? 'blocked');
          }
          if (decision.event === 'would_block' || decision.event === 'unavailable_fail_open') {
            safeCapture(capture, {
              event_type: 'egress.would_block',
              payload: { host: meta.host, audience: resource.audience, reason: decision.reason ?? 'unavailable', mode: resource.enforcement },
            });
          }
          if (token) {
            // M3: bind this request with a DPoP proof when the resource opts in.
            // htu = scheme://host/path (query stripped by the proof signer).
            const dpopProof = resource.dpop
              ? attestor.dpopProof(meta.method, `https://${meta.host}${meta.rawPath.split('?')[0]}`, token)
              : null;
            const injected = injectHeaderIntoArgs(args, token, dpopProof);
            if (injected) { callArgs = injected; attestor.recordInjected(); }
          }
        }
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const req = (original as any).apply(this, callArgs) as ClientRequest;
      try {
        req.once('response', (res: IncomingMessage) => {
          safeCapture(capture, {
            event_type: 'http.completed',
            payload: {
              host: meta.host,
              status: res.statusCode ?? 0,
              duration_ms: Date.now() - start,
              ...responseBytesField(res.headers['content-length']),
            },
          });
        });
        req.once('error', () => {
          safeCapture(capture, {
            event_type: 'http.completed',
            payload: { host: meta.host, status: 0, error: true, duration_ms: Date.now() - start },
          });
        });
      } catch {
        // listener attach failure must not break the request
      }
      return req;
    } as RequestFn;

  http.request = wrap(originals.httpRequest, false);
  http.get = wrap(originals.httpGet, false);
  https.request = wrap(originals.httpsRequest, true);
  https.get = wrap(originals.httpsGet, true);

  const restore = (): void => {
    http.request = originals.httpRequest;
    http.get = originals.httpGet;
    https.request = originals.httpsRequest;
    https.get = originals.httpsGet;
  };
  slot[PATCHED] = { restore };

  return function uninstall(): void {
    const s = (globalThis as unknown as PatchSlot)[PATCHED];
    if (s) s.restore();
    delete (globalThis as unknown as PatchSlot)[PATCHED];
  };
}

// `path` is redacted (telemetry-safe); `rawPath` keeps the real path for the DPoP
// htu claim (only used for protected https hosts; the proof signer strips query).
interface RequestMeta { host: string; method: string; path: string; rawPath: string; secure?: boolean }

function safeExtract(args: unknown[]): RequestMeta {
  try {
    let url: URL | undefined;
    let options: Record<string, unknown> = {};
    for (const a of args.slice(0, 2)) {
      if (typeof a === 'string') {
        try { url = new URL(a); } catch { /* relative or invalid */ }
      } else if (a instanceof URL) {
        url = a;
      } else if (a && typeof a === 'object') {
        options = a as Record<string, unknown>;
      }
    }
    const method = String((options['method'] as string | undefined) ?? 'GET').toUpperCase();
    // Node merges (url, options) with OPTIONS taking precedence: an explicit
    // options.hostname/host/protocol overrides the URL, and that is where the
    // socket actually connects. The token gate MUST follow the real destination,
    // so prefer options whenever it carries a host (else a url/options mismatch
    // could attach a token to the wrong place). Protocol: options wins, else url,
    // else the module the patch wrapped (http vs https).
    const optHost = (options['hostname'] as string | undefined) ?? (options['host'] as string | undefined);
    const proto = (typeof options['protocol'] === 'string' ? (options['protocol'] as string) : undefined) ?? url?.protocol;
    const secureField = proto === undefined ? {} : { secure: proto === 'https:' };
    if (optHost !== undefined && optHost !== null) {
      const rawPath = String((options['path'] as string | undefined) ?? (url ? url.pathname + url.search : '/'));
      return { host: hostFromOptions(options), method, path: redactPathString(rawPath), rawPath, ...secureField };
    }
    if (url) return { host: url.host, method, path: redactUrlPath(url), rawPath: url.pathname + url.search, ...secureField };

    const host = hostFromOptions(options);
    const rawPath = String((options['path'] as string | undefined) ?? '/');
    return { host, method, path: redactPathString(rawPath), rawPath, ...secureField };
  } catch {
    return { host: 'unknown', method: 'GET', path: '/', rawPath: '/' };
  }
}

/**
 * Return a fresh args array carrying `X-AER-Attestation` (and, when present, a
 * `DPoP` proof), cloning the options object (or inserting one) without mutating
 * the caller's objects. Skips if the attestation header is already present, or if
 * headers aren't a plain object. Returns null on any failure so the patch falls
 * back to the original args.
 */
function injectHeaderIntoArgs(args: unknown[], token: string, dpopProof?: string | null): unknown[] | null {
  try {
    let url: string | URL | undefined;
    let options: Record<string, unknown> | undefined;
    let callback: unknown;
    for (const a of args) {
      if (typeof a === 'function') callback = a;
      else if (typeof a === 'string' || a instanceof URL) url = a;
      else if (a && typeof a === 'object') options = a as Record<string, unknown>;
    }
    const existingHeaders = options?.['headers'];
    if (existingHeaders !== undefined && (typeof existingHeaders !== 'object' || Array.isArray(existingHeaders))) {
      return null; // unusual header shape (array/iterable) — don't risk corrupting it
    }
    const headers: Record<string, unknown> = { ...((existingHeaders as Record<string, unknown> | undefined) ?? {}) };
    let hasDpop = false;
    for (const k of Object.keys(headers)) {
      const lk = k.toLowerCase();
      if (lk === ATTESTATION_HEADER.toLowerCase()) return null; // never overwrite
      if (lk === 'dpop') hasDpop = true;
    }
    headers[ATTESTATION_HEADER] = token;
    if (dpopProof && !hasDpop) headers['DPoP'] = dpopProof; // never overwrite a caller's DPoP
    const newOptions: Record<string, unknown> = { ...(options ?? {}), headers };
    const out: unknown[] = [];
    if (url !== undefined) out.push(url);
    out.push(newOptions);
    if (callback !== undefined) out.push(callback);
    return out;
  } catch {
    return null;
  }
}

function hostFromOptions(options: Record<string, unknown>): string {
  const host = (options['hostname'] as string | undefined) ?? (options['host'] as string | undefined) ?? 'unknown';
  const port = options['port'];
  // host may already include a port; only append when a bare hostname + explicit port.
  if (port !== undefined && port !== null && !String(host).includes(':')) return `${host}:${String(port)}`;
  return String(host);
}

/**
 * A ClientRequest-shaped stub returned when egress is blocked: it never opens a
 * socket and instead surfaces an async `error` (code `E_AER_EGRESS_BLOCKED`) on
 * the next tick, mirroring how a real connection failure reaches the caller's
 * `req.on('error', …)`. Built on a Writable so `write`/`end`/`cork` exist; the
 * ClientRequest-only methods are harmless no-ops. A guard error listener ensures
 * the emit never throws as "unhandled" even if the caller forgot to listen.
 */
function syntheticBlockedRequest(reason: string): ClientRequest {
  const req = new Writable({ write(_chunk, _enc, cb) { cb(); }, final(cb) { cb(); } });
  const stub = req as unknown as Record<string, unknown>;
  for (const name of ['abort', 'setTimeout', 'setNoDelay', 'setSocketKeepAlive', 'flushHeaders', 'removeHeader']) {
    stub[name] = () => req;
  }
  stub['setHeader'] = () => req;
  stub['getHeader'] = () => undefined;
  stub['getHeaders'] = () => ({});
  req.on('error', () => { /* guard: keep emit() from throwing as unhandled */ });
  const err = new Error(`AER egress blocked (${reason}): no valid attestation for this protected resource`) as Error & { code?: string };
  err.code = 'E_AER_EGRESS_BLOCKED';
  process.nextTick(() => { try { req.destroy(err); } catch { /* already destroyed */ } });
  return req as unknown as ClientRequest;
}

function safeCapture(capture: Capture, event: CollectorEvent): void {
  try { capture(event); } catch { /* never break the host request */ }
}
