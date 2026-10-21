// HTTP transport: the collector's wire path to the AER API. Creates a session
// with the tenant API key, then ingests events with the returned ingest token.
// All auto-captured events are stamped source_type='wrapper'.

import type { CollectorEvent, SessionTransport } from './session.js';
import { AerRefusalError } from './session.js';
import type { Principal } from './config.js';
import { newUuidV7 } from './uuid.js';

// Re-exported so callers of this module (e.g. session.ts, and anyone using
// the transport directly) can import it from here too, without creating an
// import cycle: AerRefusalError is defined in session.ts, which this module
// already depends on.
export { AerRefusalError };

/** Collector self-declaration for capability negotiation (all fields optional). */
export interface CollectorInfo {
  name?: string;
  version?: string;
  schema_capability?: string;
}

export interface HttpTransportOptions {
  baseUrl: string;
  apiKey?: string;
  tenantId?: string;
  agentId?: string;
  envId?: string;
  agentVersion: string;
  principal?: Principal;
  /** Collector identity + event-schema capability, sent at session create. */
  collector?: CollectorInfo;
  fetchImpl?: typeof fetch;
  /**
   * How long one request to the AER API may take before it is abandoned.
   * Without a bound, an API that accepts the connection and never answers
   * would hold the host process open forever. Default 10 s.
   */
  requestTimeoutMs?: number;
  clock?: () => Date;
  newId?: () => string;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/**
 * `fetch`, abandoned after `timeoutMs`, reading the body included. A signal
 * the caller passes still applies: whichever fires first aborts the request.
 */
export function withRequestTimeout(rawFetch: typeof fetch, timeoutMs: number): (url: string, init?: RequestInit) => Promise<Response> {
  return async (url, init = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`AER request timed out after ${timeoutMs} ms`)), timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
    try {
      const res = await rawFetch(url, { ...init, signal });
      const body = await res.arrayBuffer();
      return new Response(body.byteLength > 0 ? body : null, { status: res.status, statusText: res.statusText, headers: res.headers });
    } finally {
      clearTimeout(timer);
    }
  };
}

export function createHttpTransport(opts: HttpTransportOptions): SessionTransport {
  const baseUrl = opts.baseUrl.replace(/\/$/, '');
  const rawFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const fetchImpl = withRequestTimeout(rawFetch, timeoutMs);
  const clock = opts.clock ?? (() => new Date());
  const newId = opts.newId ?? newUuidV7;

  let sessionId: string | null = null;
  let ingestToken: string | null = null;

  async function open(): Promise<void> {
    const res = await fetchImpl(`${baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${opts.apiKey ?? ''}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        tenant_id: opts.tenantId,
        agent_id: opts.agentId,
        agent_version: opts.agentVersion,
        environment_id: opts.envId,
        // Only include principal when configured, so a run without one sends the
        // exact same body as before (the API field is optional and .strict()).
        ...(opts.principal ? { principal: opts.principal } : {}),
        // Likewise for the collector self-declaration (capability negotiation):
        // omitted entirely when unset so the body stays byte-identical.
        ...(opts.collector ? { collector: opts.collector } : {}),
      }),
    });
    if (!res.ok) {
      const text = await safeText(res);
      const refusal = parseRefusal(res.status, text);
      if (refusal) throw refusal;
      throw new Error(`AER open session failed: ${res.status} ${text}`);
    }
    const json = (await res.json()) as { agent_session_id?: string; ingest_token?: string };
    if (!json.agent_session_id || !json.ingest_token) {
      throw new Error('AER open session: response missing agent_session_id / ingest_token');
    }
    sessionId = json.agent_session_id;
    ingestToken = json.ingest_token;
  }

  async function emit(events: CollectorEvent[]): Promise<void> {
    if (!sessionId || !ingestToken) throw new Error('AER transport.emit called before open()');
    if (events.length === 0) return;
    const sid = sessionId;
    const wire = events.map((e) => ({
      event_id: newId(),
      agent_session_id: sid,
      event_type: e.event_type,
      source_type: 'wrapper' as const,
      severity_hint: e.severity_hint ?? 'info',
      timestamp_observed: clock().toISOString(),
      payload: e.payload,
    }));
    const res = await fetchImpl(`${baseUrl}/v1/sessions/${sid}/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ingestToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(wire),
    });
    if (res.status !== 202 && res.status !== 207) {
      const text = await safeText(res);
      const refusal = parseRefusal(res.status, text);
      if (refusal) throw refusal;
      throw new Error(`AER emit failed: ${res.status} ${text}`);
    }
  }

  async function complete(): Promise<void> {
    const { sid, tok } = requireOpen();
    const res = await fetchImpl(`${baseUrl}/v1/sessions/${sid}/complete`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}` },
    });
    if (!res.ok) throw new Error(`AER complete failed: ${res.status} ${await safeText(res)}`);
  }

  async function abort(): Promise<void> {
    const { sid, tok } = requireOpen();
    const res = await fetchImpl(`${baseUrl}/v1/sessions/${sid}/abort`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}` },
    });
    // 409 = already terminated; idempotent, not an error.
    if (!res.ok && res.status !== 409) {
      throw new Error(`AER abort failed: ${res.status} ${await safeText(res)}`);
    }
  }

  async function mintAttestation(audience: string, scopes?: string[], dpopJkt?: string): Promise<{ token: string; expiresAtMs: number }> {
    const { sid, tok } = requireOpen();
    const body: Record<string, unknown> = { audience };
    if (scopes && scopes.length > 0) body['scopes'] = scopes;
    if (dpopJkt) body['dpop_jkt'] = dpopJkt; // bind the token to the session DPoP key (M3)
    const res = await fetchImpl(`${baseUrl}/v1/sessions/${sid}/attestations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`AER mint attestation failed: ${res.status} ${await safeText(res)}`);
    const json = (await res.json()) as { token?: string; expires_at?: string };
    if (!json.token || !json.expires_at) throw new Error('AER mint attestation: response missing token / expires_at');
    return { token: json.token, expiresAtMs: Date.parse(json.expires_at) };
  }

  function requireOpen(): { sid: string; tok: string } {
    if (!sessionId || !ingestToken) throw new Error('AER transport used before open()');
    return { sid: sessionId, tok: ingestToken };
  }

  return { open, emit, complete, abort, mintAttestation };
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

/**
 * Recognizes the AER API's two confirmed structured 403 refusal bodies
 * (usage_limit_reached, agent_paused) and turns either into an AerRefusalError
 * with a clear, plain-English message instead of a raw JSON dump. Returns
 * null for anything else (a different 403 body, a non-403 status, or text
 * that doesn't parse as JSON), so the caller's existing generic-Error
 * behavior is unchanged for every other case.
 */
function parseRefusal(status: number, bodyText: string): AerRefusalError | null {
  if (status !== 403) return null;
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object') return null;
  const o = body as Record<string, unknown>;
  const rawRecheck = typeof o['recheck_after_seconds'] === 'number' ? o['recheck_after_seconds'] : undefined;
  if (rawRecheck === undefined) return null;
  // Clamp a server-sent value before it drives a setTimeout-equivalent
  // cooldown: zero/negative would remove the backoff entirely (hammering the
  // API on every batch), and an unbounded value would silence the collector
  // for good. Ceil so a fractional value still rounds up to at least 1s.
  const recheckAfterSeconds = Math.ceil(Math.min(Math.max(rawRecheck, 1), 86_400));

  if (o['error'] === 'usage_limit_reached') {
    const unit = typeof o['unit'] === 'string' ? o['unit'] : 'usage';
    const used = o['used'];
    const limit = o['limit'];
    const upgradeUrl = typeof o['upgrade_url'] === 'string' ? o['upgrade_url'] : undefined;
    const usageDesc = used !== undefined && limit !== undefined ? `${unit} ${used}/${limit}` : unit;
    const message = `AER tenant usage cap reached (${usageDesc}); further recording is refused until a `
      + `new period or an upgrade.${upgradeUrl ? ` See ${upgradeUrl}.` : ''}`;
    return new AerRefusalError('usage_limit_reached', recheckAfterSeconds, message);
  }

  if (o['error'] === 'agent_paused') {
    const message = 'AER recording for this agent is paused by the tenant operator; recheck later.';
    return new AerRefusalError('agent_paused', recheckAfterSeconds, message);
  }

  return null;
}
