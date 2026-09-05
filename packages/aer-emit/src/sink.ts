// Best-effort AER event sinks - the shared emit core.
//
// A producer emits typed events into an `EventSink`. Two are provided:
//  - `NullSink`: no-op, used when emit is unconfigured.
//  - `createHttpSink`: opens an AER session lazily on the first emit, batches events
//    to the ingest endpoint, and completes the session on close.
//
// Every network operation is strictly best-effort. A failed session open, event
// POST or complete is swallowed (logged to stderr at most once per diagnostic
// kind) and NEVER thrown. Emitting must never be in the critical path of the
// producer's real work.
//
// close() always flushes and waits for every batch it started, including one
// that a threshold-crossing emit() fired off before close() was ever called;
// only after that does it POST /complete. A process exit still needs an
// explicit close() to seal the session - the beforeExit hook below only
// flushes whatever is buffered, best-effort, and never completes.

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

// The API's own per-request cap (MAX_EVENTS_PER_BATCH) is 1000. Posting at
// half that leaves headroom for the server to lower its cap without this
// sink needing a matching release, and keeps individual requests small
// enough to retry cheaply.
const MAX_EVENTS_PER_POST = 500;
const DEFAULT_MAX_PENDING = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 200;
const MAX_RETRY_AFTER_MS = 5_000;

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
  /**
   * Max events ever held in memory awaiting a flush. Once exceeded, the
   * oldest events are dropped to make room for new ones and the drop count is
   * reported once. Default 10000.
   */
  maxPending?: number | undefined;
  /** Per-request timeout, enforced via AbortController. Default 10000ms. */
  requestTimeoutMs?: number | undefined;
  /** Sink for one-time (per diagnostic kind) error diagnostics. Default process.stderr. */
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

/** The subset of the /events response body this sink inspects. */
interface IngestResponseBody {
  accepted?: number;
  rejected?: number;
  dropped_keys?: string[];
  warning?: string;
}

/**
 * HTTP sink that speaks the AER control-plane API. The session is opened lazily on
 * the first emit so an idle producer never touches the network. All failures are
 * swallowed and logged at most once per diagnostic kind.
 */
export function createHttpSink(opts: HttpSinkOptions): EventSink {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const sourceType = opts.sourceType ?? 'wrapper';
  const genId = opts.newId ?? (() => globalThis.crypto.randomUUID());
  const clock = opts.now ?? (() => new Date());
  const batchSize = opts.batchSize ?? 64;
  const maxPending = opts.maxPending ?? DEFAULT_MAX_PENDING;
  const requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
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
  const pending: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
  let droppedForCapacity = 0;

  // Every diagnostic kind (hard-disable, partial-accept, retry-exhausted,
  // buffer-overflow) logs at most once, so a chatty failure mode still leaves
  // exactly one line per kind rather than spamming stderr.
  const loggedKinds = new Set<string>();
  function noteOnce(kind: string, message: string): void {
    if (loggedKinds.has(kind)) return;
    loggedKinds.add(kind);
    try {
      logError(message);
    } catch {
      /* logging must never throw */
    }
  }

  function noteFatal(context: string, err: unknown): void {
    disabled = true;
    const msg = err instanceof Error ? err.message : String(err);
    noteOnce('disabled', `${label}: emit disabled after ${context}: ${msg}`);
  }

  // In-flight flush promises, tracked so close() can wait for ALL of them -
  // including one a threshold-crossing emit() started before close() was
  // ever called - not just a fresh flush of its own.
  const inFlightFlushes = new Set<Promise<void>>();
  let flushChain: Promise<void> = Promise.resolve();

  function scheduleFlush(): Promise<void> {
    const p = flushChain.then(() => doFlush());
    flushChain = p.catch(() => undefined);
    inFlightFlushes.add(p);
    const forget = (): void => {
      inFlightFlushes.delete(p);
    };
    p.then(forget, forget);
    return p;
  }

  async function sleep(ms: number): Promise<void> {
    if (ms <= 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  function parseRetryAfterMs(res: Response): number {
    const header = res.headers.get('retry-after');
    if (!header) return RETRY_BASE_MS;
    const seconds = Number(header);
    if (!Number.isFinite(seconds) || seconds < 0) return RETRY_BASE_MS;
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }

  async function timedFetch(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      return await doFetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
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
        const res = await timedFetch(`${opts.baseUrl}/v1/sessions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${opts.apiKey}`,
          },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          noteFatal('session open', new Error(`HTTP ${res.status}`));
          return null;
        }
        const json = (await res.json()) as Record<string, unknown>;
        // The API returns agent_session_id (see POST /v1/sessions). Keep id/
        // session_id as tolerant fallbacks, but the real contract is first.
        const sessionId = pickString(json, ['agent_session_id', 'id', 'session_id']);
        const ingestToken = pickString(json, ['ingest_token', 'ingestToken', 'token']);
        if (!sessionId || !ingestToken) {
          noteFatal('session open', new Error('response missing id or ingest token'));
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
        noteFatal('session open', err);
        return null;
      } finally {
        openInFlight = null;
      }
    })();
    return openInFlight;
  }

  /** Codes where the credential or the session itself is gone: retrying cannot help. */
  function isTerminal(status: number): boolean {
    return status === 401 || status === 403 || status === 404 || status === 409;
  }

  /** Codes worth a bounded retry: rate limiting and transient upstream failures. */
  function isRetryable(status: number): boolean {
    return status === 429 || status === 502 || status === 503 || status === 504;
  }

  async function postChunkWithRetry(s: OpenSession, chunk: unknown[]): Promise<void> {
    let attempt = 0;
    for (;;) {
      let res: Response;
      try {
        res = await timedFetch(`${opts.baseUrl}/v1/sessions/${s.sessionId}/events`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${s.ingestToken}`,
          },
          body: JSON.stringify(chunk),
        });
      } catch (err) {
        if (attempt < MAX_RETRIES) {
          attempt++;
          await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
          continue;
        }
        noteOnce(
          'event-ingest-dropped',
          `${label}: dropping a batch of ${chunk.length} events after ${MAX_RETRIES} retries: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }

      if (isTerminal(res.status)) {
        noteFatal('event ingest', new Error(`HTTP ${res.status}`));
        return;
      }

      if (isRetryable(res.status)) {
        if (attempt < MAX_RETRIES) {
          attempt++;
          const waitMs = res.status === 429 ? parseRetryAfterMs(res) : RETRY_BASE_MS * 2 ** (attempt - 1);
          await sleep(waitMs);
          continue;
        }
        noteOnce(
          'event-ingest-dropped',
          `${label}: dropping a batch of ${chunk.length} events after ${MAX_RETRIES} retries: HTTP ${res.status}`,
        );
        return;
      }

      if (!res.ok) {
        // Any other non-2xx (e.g. a malformed request) is not retriable and
        // does not indicate the session or credential is gone: drop this
        // batch, log once, and keep the sink usable for the next one.
        noteOnce('event-ingest-dropped', `${label}: dropping a batch of ${chunk.length} events: HTTP ${res.status}`);
        return;
      }

      let body: IngestResponseBody | null = null;
      try {
        body = (await res.json()) as IngestResponseBody;
      } catch {
        /* a 2xx with an unparsable body still counts as accepted */
      }
      if (body) {
        const rejected = typeof body.rejected === 'number' ? body.rejected : 0;
        if (res.status === 207 || rejected > 0 || body.dropped_keys?.length || body.warning) {
          noteOnce(
            'event-ingest-partial',
            `${label}: ingest reported issues on a batch (accepted=${body.accepted ?? '?'}, rejected=${rejected}${
              body.warning ? `, warning=${body.warning}` : ''
            })`,
          );
        }
      }
      return;
    }
  }

  async function doFlush(): Promise<void> {
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
    // .strict(), so stray keys (an old seq/type/ts) are rejected - send none.
    const ts = clock().toISOString();
    const all = pending.splice(0, pending.length).map((e) => ({
      event_id: genId(),
      agent_session_id: s.sessionId,
      event_type: e.eventType,
      source_type: sourceType,
      severity_hint: 'info' as const,
      timestamp_observed: ts,
      payload: e.payload,
    }));
    // Chunk so no single request can ever exceed the server's per-batch cap.
    for (let i = 0; i < all.length; i += MAX_EVENTS_PER_POST) {
      if (disabled) return;
      const chunk = all.slice(i, i + MAX_EVENTS_PER_POST);
      await postChunkWithRetry(s, chunk);
    }
  }

  // A single beforeExit handler flushes whatever is buffered, best-effort,
  // when the event loop would otherwise go idle. This is not a signal
  // handler and changes no signal semantics; a caller that wants the session
  // marked complete still must call close() itself.
  const exitHandler = (): void => {
    scheduleFlush().catch(() => undefined);
  };
  process.on('beforeExit', exitHandler);
  let exitHandlerRemoved = false;
  function removeExitHandler(): void {
    if (exitHandlerRemoved) return;
    exitHandlerRemoved = true;
    process.removeListener('beforeExit', exitHandler);
  }

  return {
    emit(eventType, payload): void {
      if (disabled) return;
      pending.push({ eventType, payload });
      if (pending.length > maxPending) {
        const overflow = pending.length - maxPending;
        pending.splice(0, overflow);
        droppedForCapacity += overflow;
        noteOnce(
          'buffer-overflow',
          `${label}: dropped ${overflow} oldest buffered event(s), buffer over its ${maxPending}-event cap (total dropped so far: ${droppedForCapacity})`,
        );
      }
      if (pending.length >= batchSize) {
        // fire-and-forget; the caller must never await the emit path
        scheduleFlush().catch(() => undefined);
      }
    },
    async close(): Promise<void> {
      removeExitHandler();
      // Ensure a final flush is scheduled, then wait for it and every flush
      // still in flight (including one a prior emit() fired off) before
      // treating the buffer as drained.
      scheduleFlush().catch(() => undefined);
      while (inFlightFlushes.size > 0) {
        await Promise.allSettled([...inFlightFlushes]);
      }
      if (opts.completeOnClose === false) return;
      if (!openAttempted || disabled || !session) return;
      try {
        const res = await timedFetch(`${opts.baseUrl}/v1/sessions/${session.sessionId}/complete`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${session.ingestToken}`,
          },
          body: JSON.stringify({}),
        });
        if (!res.ok) noteOnce('complete-failed', `${label}: session complete failed: HTTP ${res.status}`);
      } catch (err) {
        noteOnce('complete-failed', `${label}: session complete failed: ${err instanceof Error ? err.message : String(err)}`);
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
