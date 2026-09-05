// Patch global fetch -> http.requested / http.completed.
//
// Rules (ADR-008 / spec §4): idempotent, preserves + restores the original,
// never throws into the host (capture is best-effort, the original call always
// runs and its result/error is passed through), no bodies/headers, query
// string redacted.

import type { CollectorEvent } from '../session.js';
import type { Attestor } from '../attestor.js';
import { redactUrlPath } from '../redaction.js';
import { responseBytesField } from './response-size.js';

type Capture = (event: CollectorEvent) => void;

const ATTESTATION_HEADER = 'x-aer-attestation';
const DPOP_HEADER = 'dpop';

const PATCHED = Symbol.for('adastra.aer.patched.fetch');
const ORIGINAL = Symbol.for('adastra.aer.original.fetch');

interface PatchSlot {
  [PATCHED]?: boolean;
  [ORIGINAL]?: typeof fetch;
}

const noop = (): void => undefined;

export function installFetchPatch(capture: Capture, attestor?: Attestor): () => void {
  const slot = globalThis as unknown as PatchSlot;
  const original = globalThis.fetch;
  if (slot[PATCHED] || typeof original !== 'function') return noop;

  slot[PATCHED] = true;
  slot[ORIGINAL] = original;

  const patched = async function patchedFetch(
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> {
    const meta = safeExtract(input, init);
    const start = Date.now();
    safeCapture(capture, {
      event_type: 'http.requested',
      payload: { host: meta.host, method: meta.method, path_redacted: meta.path },
    });
    // Attestation injection: HTTPS + configured protected hosts only. Build a
    // sender that attaches X-AER-Attestation; the default is the untouched call
    // so non-protected traffic sees ZERO behavior change. Best-effort - any
    // failure falls through to the un-injected original.
    let send: () => Promise<Response> = () => original(input, init);
    if (attestor && meta.secure && meta.host !== 'unknown') {
      const resource = attestor.resourceFor(meta.host);
      if (resource) {
        try {
          let token: string | null = null;
          try { token = await attestor.getToken(resource.audience, resource.scopes, resource.dpop); } catch { token = null; }
          // M2 egress enforcement. In 'off' this is always allow + no event, so
          // the additive injection below is byte-for-byte the prior behavior.
          const decision = attestor.evaluateEgress(resource, token);
          if (!decision.allow) {
            safeCapture(capture, {
              event_type: 'egress.blocked',
              payload: { host: meta.host, audience: resource.audience, reason: decision.reason ?? 'blocked' },
            });
            return blockedResponse(decision.reason ?? 'blocked');
          }
          if (decision.event === 'would_block' || decision.event === 'unavailable_fail_open') {
            safeCapture(capture, {
              event_type: 'egress.would_block',
              payload: { host: meta.host, audience: resource.audience, reason: decision.reason ?? 'unavailable', mode: resource.enforcement },
            });
          }
          if (token) {
            // M3: bind this request with a DPoP proof when the resource opts in.
            const dpopProof = resource.dpop && meta.url ? attestor.dpopProof(meta.method, meta.url, token) : null;
            const injected = buildInjectedSender(original, input, init, token, resource.audience, attestor, dpopProof);
            if (injected) { send = injected; attestor.recordInjected(); }
          }
        } catch {
          // never break the host's request over instrumentation
        }
      }
    }
    try {
      const res = await send();
      safeCapture(capture, {
        event_type: 'http.completed',
        payload: {
          host: meta.host,
          status: res.status,
          duration_ms: Date.now() - start,
          ...responseBytesField(res.headers.get('content-length')),
        },
      });
      return res;
    } catch (err) {
      safeCapture(capture, {
        event_type: 'http.completed',
        payload: { host: meta.host, status: 0, error: true, duration_ms: Date.now() - start },
      });
      throw err;
    }
  };

  globalThis.fetch = patched as unknown as typeof fetch;

  return function uninstall(): void {
    if (slot[ORIGINAL]) globalThis.fetch = slot[ORIGINAL];
    delete slot[PATCHED];
    delete slot[ORIGINAL];
  };
}

/**
 * Synthetic 403 returned when egress is blocked. Mirrors what the resource-side
 * guard would have answered, so the agent's own error handling fires (rather than
 * a thrown exception that could crash a naive caller). The original fetch is
 * never invoked, so no request body leaves the process.
 */
function blockedResponse(reason: string): Response {
  return new Response(JSON.stringify({ error: 'aer_egress_blocked', reason }), {
    status: 403,
    headers: { 'content-type': 'application/json', 'x-aer-egress': 'blocked' },
  });
}

interface RequestMeta { host: string; method: string; path: string; secure: boolean; url: string }

function safeExtract(input: unknown, init?: { method?: string }): RequestMeta {
  try {
    let url: string;
    let method = init?.method ?? 'GET';
    if (typeof input === 'string') {
      url = input;
    } else if (input instanceof URL) {
      url = input.href;
    } else if (input && typeof input === 'object' && 'url' in input) {
      const req = input as { url: string; method?: string };
      url = req.url;
      method = init?.method ?? req.method ?? 'GET';
    } else {
      url = String(input);
    }
    const parsed = new URL(url);
    // url carries the REAL (unredacted) target for the DPoP htu claim; the htu
    // normalizer strips its query, and it's only used for protected https hosts.
    return { host: parsed.host, method: method.toUpperCase(), path: redactUrlPath(parsed), secure: parsed.protocol === 'https:', url: parsed.href };
  } catch {
    return { host: 'unknown', method: (init?.method ?? 'GET').toUpperCase(), path: '/', secure: false, url: '' };
  }
}

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];
type FetchBody = NonNullable<FetchInit>['body'];

const MAX_REDIRECTS = 20;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/**
 * Build a sender that attaches `X-AER-Attestation`, handling redirects so the
 * token NEVER crosses to a different audience (cross-origin leak). The header is
 * passed via `init` so it uniformly overrides a Request input's own headers,
 * without mutating the caller's objects. Returns null (caller falls back to the
 * untouched original) when the header is already present or anything fails.
 */
function buildInjectedSender(
  original: typeof fetch,
  input: FetchInput,
  init: FetchInit,
  token: string,
  audience: string,
  attestor: Attestor,
  dpopProof: string | null,
): (() => Promise<Response>) | null {
  const isRequest = typeof Request !== 'undefined' && input instanceof Request;
  let headers: Headers;
  try {
    const base = init?.headers ?? (isRequest ? (input as Request).headers : undefined);
    headers = new Headers(base as ConstructorParameters<typeof Headers>[0]);
  } catch {
    return null;
  }
  if (headers.has(ATTESTATION_HEADER)) return null; // caller already attested: never overwrite
  headers.set(ATTESTATION_HEADER, token);

  // M3: a DPoP proof is bound to THIS method+url. Attach it and never auto-follow
  // redirects (a redirect would carry a stale htu); surface the 3xx instead.
  if (dpopProof) {
    headers.set(DPOP_HEADER, dpopProof);
    attestor.recordManualFallback();
    return () => original(input, { ...(init ?? {}), headers, redirect: 'manual' });
  }

  const callerRedirect = init?.redirect ?? (isRequest ? (input as Request).redirect : undefined) ?? 'follow';

  // Not following ('manual'/'error'): one injected request is safe - with no
  // follow the token can't reach another origin. Respect the caller's mode.
  if (callerRedirect !== 'follow') {
    return () => original(input, { ...(init ?? {}), headers, redirect: callerRedirect });
  }

  // Follow mode: intercept redirects ourselves. Re-issuing across hops needs a
  // re-usable body; a streamed body (or any Request input's body) is one-shot,
  // so for those we force redirect:'manual' and surface the 3xx rather than risk
  // a broken re-send. Protected resources normally answer 2xx, so this only bites
  // the rare redirecting-protected-endpoint case.
  const method = (init?.method ?? (isRequest ? (input as Request).method : undefined) ?? 'GET').toUpperCase();
  const body = init?.body ?? undefined;
  if (isRequest || !isReusableBody(body)) {
    attestor.recordManualFallback();
    return () => original(input, { ...(init ?? {}), headers, redirect: 'manual' });
  }

  let startUrl: string;
  try { startUrl = urlOf(input); } catch { return null; }
  return () => followManually(original, init, startUrl, method, body, headers, token, audience, attestor);
}

/** Follow redirects by hand, re-injecting the token only for the same audience. */
async function followManually(
  original: typeof fetch,
  init: FetchInit,
  startUrl: string,
  method: string,
  body: FetchBody,
  headers: Headers,
  token: string,
  audience: string,
  attestor: Attestor,
): Promise<Response> {
  const baseInit = { ...(init ?? {}) };
  delete baseInit.body; // body is managed per-hop (may be dropped on 301/302/303)

  let url = startUrl;
  let curMethod = method;
  let curBody: FetchBody = body;
  let curHeaders = headers;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const reqInit: FetchInit = {
      ...baseInit,
      method: curMethod,
      headers: curHeaders,
      redirect: 'manual' as const,
      ...(curBody === undefined || curBody === null ? {} : { body: curBody }),
    };
    const res = await original(url, reqInit);
    if (!REDIRECT_STATUS.has(res.status)) return res;
    const loc = res.headers.get('location');
    if (!loc || hop === MAX_REDIRECTS) return res; // no target, or hop budget spent

    let target: URL;
    try { target = new URL(loc, url); } catch { return res; }

    const next = nextRequest(res.status, curMethod);
    curMethod = next.method;
    if (next.dropBody) curBody = undefined;

    // Re-inject ONLY when the redirect target maps to the SAME audience over
    // https; otherwise strip the token so it never reaches another origin.
    const headers2 = new Headers(curHeaders);
    const hadToken = headers2.has(ATTESTATION_HEADER);
    headers2.delete(ATTESTATION_HEADER);
    if (target.protocol === 'https:' && attestor.audienceFor(target.host) === audience) {
      headers2.set(ATTESTATION_HEADER, token);
    } else if (hadToken) {
      attestor.recordCrossOriginStripped();
    }
    curHeaders = headers2;
    url = target.href;
  }
  return original(url, { ...baseInit, method: curMethod, headers: curHeaders, redirect: 'manual' as const });
}

/** Method/body transition for a redirect status, mirroring the fetch spec. */
function nextRequest(status: number, method: string): { method: string; dropBody: boolean } {
  if (status === 303 && method !== 'GET' && method !== 'HEAD') return { method: 'GET', dropBody: true };
  if ((status === 301 || status === 302) && method === 'POST') return { method: 'GET', dropBody: true };
  return { method, dropBody: false };
}

/** A body that can be re-sent across redirect hops (NOT a one-shot stream). */
function isReusableBody(body: unknown): boolean {
  if (body === undefined || body === null) return true;
  if (typeof body === 'string') return true;
  if (typeof ArrayBuffer !== 'undefined' && (body instanceof ArrayBuffer || ArrayBuffer.isView(body))) return true;
  if (typeof Blob !== 'undefined' && body instanceof Blob) return true;
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return true;
  if (typeof FormData !== 'undefined' && body instanceof FormData) return true;
  return false; // ReadableStream and anything else: treat as one-shot
}

function urlOf(input: FetchInput): string {
  if (typeof input === 'string') return new URL(input).href;
  if (input instanceof URL) return input.href;
  if (input && typeof input === 'object' && 'url' in input) return new URL((input as { url: string }).url).href;
  return new URL(String(input)).href;
}

function safeCapture(capture: Capture, event: CollectorEvent): void {
  try {
    capture(event);
  } catch {
    // Instrumentation must never break the host's network call.
  }
}
