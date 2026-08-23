// HTTP transport: the collector's wire path to the AER API. Creates a session
// with the tenant API key, then ingests events with the returned ingest token.
// All auto-captured events are stamped source_type='wrapper'.

import type { CollectorEvent, SessionTransport } from './session.js';
import type { Principal } from './config.js';
import { newUuidV7 } from './uuid.js';

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
  clock?: () => Date;
  newId?: () => string;
}

export function createHttpTransport(opts: HttpTransportOptions): SessionTransport {
  const baseUrl = opts.baseUrl.replace(/\/$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;
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
      throw new Error(`AER open session failed: ${res.status} ${await safeText(res)}`);
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
      throw new Error(`AER emit failed: ${res.status} ${await safeText(res)}`);
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
