// The three calls the hook makes to the AER session API, each bounded by the
// time the invocation has left and each reporting what happened rather than
// swallowing it: the caller decides whether queued events stay queued.

import type { HttpSinkOptions } from '@adastracomputing/aer-emit';
import type { OutboxEvent } from './session-store.js';

export type CallResult =
  | { ok: true; status: number; body: Record<string, unknown> }
  | { ok: false; status: number; error: string | undefined; text?: string; timedOut?: boolean };

/** status 0: no answer at all (refused, reset, timed out). */
const NO_ANSWER = 0;

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
    const text = await res.text().catch(() => '');
    let parsed: Record<string, unknown> = {};
    try {
      const j = JSON.parse(text) as unknown;
      if (typeof j === 'object' && j !== null && !Array.isArray(j)) parsed = j as Record<string, unknown>;
    } catch {
      /* an empty or unparsable body still has a status */
    }
    if (res.ok) return { ok: true, status: res.status, body: parsed };
    return { ok: false, status: res.status, error: typeof parsed['error'] === 'string' ? parsed['error'] : undefined, text: text.slice(0, 2048) };
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
