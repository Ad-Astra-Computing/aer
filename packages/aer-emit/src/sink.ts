// Best-effort AER event sinks — the shared emit core.
//
// A producer emits typed events into an `EventSink`. Two are provided:
//  - `NullSink`: no-op, used when emit is unconfigured.
//  - `createHttpSink`: opens an AER session lazily on the first emit, batches events
//    to the ingest endpoint, and completes the session on close.
//
// Every network operation is strictly best-effort. A failed session open, event
// POST or complete is swallowed (logged to stderr at most once) and NEVER thrown.
// Emitting must never be in the critical path of the producer's real work.

import type { Principal } from './principal.js';

export type { Principal } from './principal.js';

export interface EventSink {
  /** Record one event. Must not throw; returns void or a Promise the caller may ignore. */
  emit(eventType: string, payload: Record<string, unknown>): void | Promise<void>;
  /** Flush and, if the sink owns a session, complete it. Must not reject. */
  close(): Promise<void>;
}

/** No-op sink. Used when emit is unconfigured. */
export class NullSink implements EventSink {
  emit(): void {
    /* no-op */
  }
  async close(): Promise<void> {
    /* no-op */
  }
}

export interface HttpSinkOptions {
  baseUrl: string;
  apiKey: string;
  tenantId?: string | undefined;
  agentId?: string | undefined;
  environmentId?: string | undefined;
  agentVersion?: string | undefined;
  principal?: Principal | undefined;
  /** Injectable fetch for tests. Defaults to global fetch. */
  fetch?: typeof fetch | undefined;
  /**
   * source_type stamped on every event. Must be one of the API's SOURCE_TYPES
   * enum (sdk|wrapper|ebpf|gateway|user|import). Default 'wrapper' (harness/hook
   * capture is auto-instrumentation, same category the auto-node collector uses).
   */
  sourceType?: 'sdk' | 'wrapper' | 'ebpf' | 'gateway' | 'user' | 'import' | undefined;
  /** Injectable event_id generator for tests. Defaults to crypto.randomUUID(). */
  newId?: (() => string) | undefined;
  /** Injectable clock for tests. Defaults to new Date(). */
  now?: (() => Date) | undefined;
  /** Max events buffered before a flush is triggered. Default 64. */
  batchSize?: number | undefined;
  /** Sink for one-time error diagnostics. Default process.stderr. */
  logError?: ((message: string) => void) | undefined;
  /** Label used in the one-time error diagnostic. Default 'aer-emit'. */
  logLabel?: string | undefined;
  /**
   * Attach to an already-open session instead of opening a new one. When set,
   * the sink never POSTs /v1/sessions and emits straight to the given session
   * with the given ingest token. Used to share one AER session across separate
   * hook processes.
   */
  session?: { id: string; ingestToken: string } | undefined;
  /**
   * POST /complete on close(). Default true. Set false when this sink is a
   * short-lived participant in a session whose lifecycle another process owns
   * (e.g. a per-tool-call hook that must not end the harness session).
   */
  completeOnClose?: boolean | undefined;
  /**
   * Called once with the session identity the moment a session is opened
   * lazily (never called in attach mode). Lets the caller persist the id and
   * ingest token so later processes can attach to the same session.
   */
  onOpen?: ((info: { id: string; ingestToken: string }) => void) | undefined;
}

interface OpenSession {
  sessionId: string;
  ingestToken: string;
}

/**
 * HTTP sink that speaks the AER control-plane API. The session is opened lazily on
 * the first emit so an idle producer never touches the network. All failures are
 * swallowed and logged at most once.
 */
export function createHttpSink(opts: HttpSinkOptions): EventSink {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const sourceType = opts.sourceType ?? 'wrapper';
  const genId = opts.newId ?? (() => globalThis.crypto.randomUUID());
  const clock = opts.now ?? (() => new Date());
  const batchSize = opts.batchSize ?? 64;
  const label = opts.logLabel ?? 'aer-emit';
  const logError = opts.logError ?? ((m: string) => process.stderr.write(m + '\n'));

  // Attach mode: a session was handed to us, so we never open one.
  const attached = opts.session !== undefined;
  let session: OpenSession | null = attached
    ? { sessionId: opts.session!.id, ingestToken: opts.session!.ingestToken }
    : null;
  let openAttempted = attached;
  let openInFlight: Promise<OpenSession | null> | null = null;
  let disabled = false;
  let loggedError = false;
  const pending: Array<{ eventType: string; payload: Record<string, unknown> }> = [];

  function noteError(context: string, err: unknown): void {
    if (loggedError) return;
    loggedError = true;
    const msg = err instanceof Error ? err.message : String(err);
    try {
      logError(`${label}: emit disabled after ${context}: ${msg}`);
    } catch {
      /* logging must never throw */
    }
  }

  async function openSession(): Promise<OpenSession | null> {
    if (session) return session;
    if (openInFlight) return openInFlight;
    openAttempted = true;
    openInFlight = (async () => {
      try {
        const body: Record<string, unknown> = {};
        if (opts.tenantId !== undefined) body['tenant_id'] = opts.tenantId;
        if (opts.agentId !== undefined) body['agent_id'] = opts.agentId;
        if (opts.environmentId !== undefined) body['environment_id'] = opts.environmentId;
        if (opts.agentVersion !== undefined) body['agent_version'] = opts.agentVersion;
        if (opts.principal !== undefined) body['principal'] = opts.principal;
        const res = await doFetch(`${opts.baseUrl}/v1/sessions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${opts.apiKey}`,
          },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          noteError('session open', new Error(`HTTP ${res.status}`));
          disabled = true;
          return null;
        }
        const json = (await res.json()) as Record<string, unknown>;
        // The API returns agent_session_id (see POST /v1/sessions). Keep id/
        // session_id as tolerant fallbacks, but the real contract is first.
        const sessionId = pickString(json, ['agent_session_id', 'id', 'session_id']);
        const ingestToken = pickString(json, ['ingest_token', 'ingestToken', 'token']);
        if (!sessionId || !ingestToken) {
          noteError('session open', new Error('response missing id or ingest token'));
          disabled = true;
          return null;
        }
        session = { sessionId, ingestToken };
        if (opts.onOpen) {
          try {
            opts.onOpen({ id: sessionId, ingestToken });
          } catch {
            /* onOpen persistence is best-effort and must never break the sink */
          }
        }
        return session;
      } catch (err) {
        noteError('session open', err);
        disabled = true;
        return null;
      } finally {
        openInFlight = null;
      }
    })();
    return openInFlight;
  }

  async function flush(): Promise<void> {
    if (disabled) {
      pending.length = 0;
      return;
    }
    // Never open a session just to flush nothing; an idle producer stays off-network.
    if (pending.length === 0) return;
    const s = session ?? (await openSession());
    if (!s) {
      pending.length = 0;
      return;
    }
    if (pending.length === 0) return;
    // Wire shape MUST match the API's EventSchema: BaseEvent fields (event_id,
    // agent_session_id, source_type, timestamp_observed, severity_hint) plus
    // event_type + payload, posted as a BARE ARRAY. The variant schema is
    // .strict(), so stray keys (an old seq/type/ts) are rejected — send none.
    const ts = clock().toISOString();
    const batch = pending.splice(0, pending.length).map((e) => ({
      event_id: genId(),
      agent_session_id: s.sessionId,
      event_type: e.eventType,
      source_type: sourceType,
      severity_hint: 'info' as const,
      timestamp_observed: ts,
      payload: e.payload,
    }));
    try {
      const res = await doFetch(`${opts.baseUrl}/v1/sessions/${s.sessionId}/events`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${s.ingestToken}`,
        },
        body: JSON.stringify(batch),
      });
      if (!res.ok) {
        noteError('event ingest', new Error(`HTTP ${res.status}`));
        disabled = true;
      }
    } catch (err) {
      noteError('event ingest', err);
      disabled = true;
    }
  }

  return {
    emit(eventType, payload): void {
      if (disabled) return;
      pending.push({ eventType, payload });
      if (pending.length >= batchSize) {
        // fire-and-forget; the caller must never await the emit path
        void flush().catch(() => undefined);
      }
    },
    async close(): Promise<void> {
      try {
        await flush();
      } catch (err) {
        noteError('final flush', err);
      }
      if (opts.completeOnClose === false) return;
      if (!openAttempted || disabled || !session) return;
      try {
        const res = await doFetch(`${opts.baseUrl}/v1/sessions/${session.sessionId}/complete`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${session.ingestToken}`,
          },
          body: JSON.stringify({}),
        });
        if (!res.ok) noteError('session complete', new Error(`HTTP ${res.status}`));
      } catch (err) {
        noteError('session complete', err);
      }
    },
  };
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}
