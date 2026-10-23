// The three calls the hook makes to the AER session API, each bounded by the
// time the invocation has left and each reporting what happened rather than
// swallowing it: the caller decides whether queued events stay queued.

import type { HttpSinkOptions } from '@adastracomputing/aer-emit';
import type { OutboxEvent } from './session-store.js';

/**
 * The AER API's two confirmed structured 403 bodies (open session / post
 * events): the tenant's usage cap was reached, or this agent is paused by the
 * tenant operator. `recheckAfterSeconds` is the server's own backoff; the
 * caller stops retrying until it elapses rather than hammering the API on
 * every later invocation.
 */
export interface Refusal {
  kind: 'usage_limit_reached' | 'agent_paused';
  recheckAfterSeconds: number;
  upgradeUrl?: string;
}

// CVE-2026-111497 (Node Brotli decoder OOB write, RCE-capable): fetch() decodes
// a body lazily on first read, based on the server's own Content-Encoding, and
// a hostile server picks that header regardless of what was requested. The
// session API is operator-configured but still an external server whose
// bytes this process does not control, so the body is never read until this
// passes.
function isCompressed(res: Response): string | null {
  const enc = res.headers.get('content-encoding');
  return enc !== null && enc.toLowerCase() !== 'identity' ? enc : null;
}

export type CallResult =
  | { ok: true; status: number; body: Record<string, unknown> }
  | { ok: false; status: number; error: string | undefined; text?: string; timedOut?: boolean; refusal?: Refusal };

/** status 0: no answer at all (refused, reset, timed out). */
const NO_ANSWER = 0;
/** A compressed response is a deliberate refusal (CVE-2026-111497), not a
 * network condition: giving it its own status keeps isRetryable from
 * retrying a hostile or misconfigured endpoint that will answer the same
 * way every time, and keeps outcome() from reporting it as "no answer",
 * which would hide the real reason from the operator. */
const REFUSED_COMPRESSED = -1;

/**
 * Recognizes the two confirmed structured 403 bodies and returns the fields
 * the caller needs to back off instead of treating the session as gone.
 * Returns undefined for any other body shape, so an unrelated 403 keeps
 * today's behavior exactly.
 */
function parseRefusal(status: number, parsed: Record<string, unknown>): Refusal | undefined {
  if (status !== 403) return undefined;
  const rawRecheck = typeof parsed['recheck_after_seconds'] === 'number' ? parsed['recheck_after_seconds'] : undefined;
  if (rawRecheck === undefined) return undefined;
  // Clamp before this drives refusedUntil: zero/negative removes the
  // backoff, an unbounded value silences the hook for good, and a fractional
  // value is dropped on the next reload by session-store's isInt check.
  // Ceil so a fractional value still rounds up to at least 1s.
  const recheckAfterSeconds = Math.ceil(Math.min(Math.max(rawRecheck, 1), 86_400));
  if (parsed['error'] === 'usage_limit_reached') {
    const upgradeUrl = typeof parsed['upgrade_url'] === 'string' ? parsed['upgrade_url'] : undefined;
    return { kind: 'usage_limit_reached', recheckAfterSeconds, ...(upgradeUrl ? { upgradeUrl } : {}) };
  }
  if (parsed['error'] === 'agent_paused') {
    return { kind: 'agent_paused', recheckAfterSeconds };
  }
  return undefined;
}

/** A clear, plain-English line for ctx.warn, never a raw JSON dump. */
export function refusalMessage(r: Refusal): string {
  if (r.kind === 'usage_limit_reached') {
    return `the tenant's AER usage cap has been reached; recording is refused until a new period or an upgrade${r.upgradeUrl ? ` (${r.upgradeUrl})` : ''}`;
  }
  return 'this agent is paused by the tenant operator; recording is refused until it is resumed';
}

export interface ApiBase {
  base: HttpSinkOptions & { sourceType: string };
  fetch: typeof fetch;
}

async function call(api: ApiBase, path: string, token: string, body: unknown, timeoutMs: number): Promise<CallResult> {
  if (timeoutMs <= 0) return { ok: false, status: NO_ANSWER, error: 'no_time_left' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await api.fetch(`${api.base.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const compressedAs = isCompressed(res);
    if (compressedAs !== null) {
      await res.body?.cancel();
      return { ok: false, status: REFUSED_COMPRESSED, error: `compressed_response_${compressedAs}` };
    }
    const text = await res.text().catch(() => '');
    let parsed: Record<string, unknown> = {};
    try {
      const j = JSON.parse(text) as unknown;
      if (typeof j === 'object' && j !== null && !Array.isArray(j)) parsed = j as Record<string, unknown>;
    } catch {
      /* an empty or unparsable body still has a status */
    }
    if (res.ok) return { ok: true, status: res.status, body: parsed };
    const refusal = parseRefusal(res.status, parsed);
    return {
      ok: false,
      status: res.status,
      error: typeof parsed['error'] === 'string' ? parsed['error'] : undefined,
      text: text.slice(0, 2048),
      ...(refusal ? { refusal } : {}),
    };
  } catch {
    // Aborted by the timer: the request ran for its whole time without an answer.
    return controller.signal.aborted
      ? { ok: false, status: NO_ANSWER, error: 'timed_out', timedOut: true }
      : { ok: false, status: NO_ANSWER, error: undefined };
  } finally {
    clearTimeout(timer);
  }
}

export interface Opened {
  id: string;
  ingestToken: string;
  reused: boolean;
}

/** POST /v1/sessions with the client_ref that makes a repeat open reuse the running session. */
export async function openSession(api: ApiBase, clientRef: string | undefined, timeoutMs: number): Promise<{ opened: Opened } | { failed: CallResult & { ok: false } }> {
  const b = api.base;
  const bodyOf = (withRef: boolean): Record<string, unknown> => {
    const body: Record<string, unknown> = {};
    if (b.tenantId !== undefined) body['tenant_id'] = b.tenantId;
    if (b.agentId !== undefined) body['agent_id'] = b.agentId;
    if (b.environmentId !== undefined) body['environment_id'] = b.environmentId;
    if (b.agentVersion !== undefined) body['agent_version'] = b.agentVersion;
    if (b.principal !== undefined) body['principal'] = b.principal;
    if (b.collector !== undefined) body['collector'] = b.collector;
    if (withRef && clientRef !== undefined) body['client_ref'] = clientRef;
    return body;
  };
  let r = await call(api, '/v1/sessions', b.apiKey, bodyOf(true), timeoutMs);
  // A server that predates client_ref rejects the field outright; retry once without it.
  if (!r.ok && r.status === 400 && clientRef !== undefined && /client_ref/.test(r.text ?? '')) {
    r = await call(api, '/v1/sessions', b.apiKey, bodyOf(false), timeoutMs);
  }
  if (!r.ok) return { failed: r };
  const pick = (keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = r.ok ? r.body[k] : undefined;
      if (typeof v === 'string' && v.length > 0) return v;
    }
    return undefined;
  };
  const id = pick(['agent_session_id', 'id', 'session_id']);
  const ingestToken = pick(['ingest_token', 'ingestToken', 'token']);
  if (id === undefined || ingestToken === undefined) return { failed: { ok: false, status: r.status, error: 'response_missing_session' } };
  return { opened: { id, ingestToken, reused: r.body['reused'] === true } };
}

/** POST a batch of queued events as the bare array the ingest endpoint takes. */
export function postEvents(api: ApiBase, session: { id: string; ingestToken: string }, events: OutboxEvent[], timeoutMs: number): Promise<CallResult> {
  const wire = events.map((e) => ({
    event_id: e.id,
    agent_session_id: session.id,
    event_type: e.type,
    source_type: api.base.sourceType,
    severity_hint: 'info',
    timestamp_observed: e.ts,
    payload: e.payload,
  }));
  return call(api, `/v1/sessions/${session.id}/events`, session.ingestToken, wire, timeoutMs);
}

export function completeSession(api: ApiBase, session: { id: string; ingestToken: string }, timeoutMs: number): Promise<CallResult> {
  return call(api, `/v1/sessions/${session.id}/complete`, session.ingestToken, {}, timeoutMs);
}

/** Worth trying again later: the server is busy or briefly unavailable, or never answered. */
export function isRetryable(r: CallResult): boolean {
  return !r.ok && (r.status === NO_ANSWER || r.status === 429 || r.status >= 500);
}
