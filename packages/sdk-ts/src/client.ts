import { newUuidV7 } from './uuid.js';

export interface AerClientOptions {
  baseUrl: string;
  sessionId: string;
  ingestToken: string;
  batchSize?: number;
  flushIntervalMs?: number;
  maxRetries?: number;
  retryBaseMs?: number;
  fetchImpl?: typeof fetch;
  clock?: () => Date;
}

export interface IngestResult {
  accepted: number;
  rejected: number;
  errors: unknown[];
}

export interface CompleteResult {
  aer_id: string;
  canonical_hash: string;
  signing_key_id: string;
  findings_count: number;
}

export interface AerClient {
  emit(eventType: string, payload: Record<string, unknown>, opts?: EmitOpts): Promise<void>;
  abort(): Promise<void>;
  flush(): Promise<IngestResult[]>;
  complete(): Promise<CompleteResult>;
  close(): Promise<void>;
}

export interface EmitOpts {
  severity_hint?: 'info' | 'low' | 'medium' | 'high' | 'critical';
}

interface QueuedEvent {
  event_id: string;
  agent_session_id: string;
  event_type: string;
  source_type: 'sdk';
  severity_hint: 'info' | 'low' | 'medium' | 'high' | 'critical';
  timestamp_observed: string;
  payload: Record<string, unknown>;
}

export function createAerClient(opts: AerClientOptions): AerClient {
  const baseUrl = opts.baseUrl.replace(/\/$/, '');
  const sessionId = opts.sessionId;
  const token = opts.ingestToken;
  const batchSize = opts.batchSize ?? 50;
  const flushIntervalMs = opts.flushIntervalMs ?? 500;
  const maxRetries = opts.maxRetries ?? 3;
  const retryBaseMs = opts.retryBaseMs ?? 100;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const clock = opts.clock ?? (() => new Date());

  const buffer: QueuedEvent[] = [];
  let closed = false;
  let inflightFlush: Promise<IngestResult[]> | null = null;

  const timer: NodeJS.Timeout = setInterval(() => {
    if (buffer.length === 0 || closed) return;
    void flush().catch(() => {
      /* errors surfaced via explicit flush() only; background flush swallows */
    });
  }, flushIntervalMs);
  timer.unref?.();

  async function emit(
    eventType: string,
    payload: Record<string, unknown>,
    emitOpts: EmitOpts = {},
  ): Promise<void> {
    if (closed) throw new Error('AerClient is closed');
    buffer.push({
      event_id: newUuidV7(),
      agent_session_id: sessionId,
      event_type: eventType,
      source_type: 'sdk',
      severity_hint: emitOpts.severity_hint ?? 'info',
      timestamp_observed: clock().toISOString(),
      payload,
    });
    if (buffer.length >= batchSize) {
      await flush();
    }
  }

  async function flush(): Promise<IngestResult[]> {
    if (inflightFlush) return inflightFlush;
    const results: IngestResult[] = [];

    inflightFlush = (async () => {
      while (buffer.length > 0) {
        const chunk = buffer.splice(0, batchSize);
        try {
          results.push(await postWithRetry(chunk));
        } catch (err) {
          buffer.unshift(...chunk);
          throw err;
        }
      }
      return results;
    })();

    try {
      return await inflightFlush;
    } finally {
      inflightFlush = null;
    }
  }

  async function postWithRetry(chunk: QueuedEvent[]): Promise<IngestResult> {
    let lastErr: unknown;
    for (let i = 0; i <= maxRetries; i++) {
      const res = await fetchImpl(`${baseUrl}/v1/sessions/${sessionId}/events`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(chunk),
      });
      if (res.status === 202 || res.status === 207) {
        return (await res.json()) as IngestResult;
      }
      if (res.status >= 400 && res.status < 500) {
        throw new Error(`AER ingest failed: ${res.status} ${await safeText(res)}`);
      }
      lastErr = new Error(`AER ingest ${res.status}`);
      await sleep(retryBaseMs * 2 ** i);
    }
    throw lastErr ?? new Error('AER ingest failed after retries');
  }

  async function complete(): Promise<CompleteResult> {
    await flush();
    const res = await fetchImpl(`${baseUrl}/v1/sessions/${sessionId}/complete`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(`AER complete failed: ${res.status} ${await safeText(res)}`);
    }
    return (await res.json()) as CompleteResult;
  }

  // Crash-recovery path: marks session as terminated without generating an AER.
  // Idempotent on already-terminated sessions (server returns 409 which we surface).
  async function abort(): Promise<void> {
    await flush();
    const res = await fetchImpl(`${baseUrl}/v1/sessions/${sessionId}/abort`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok && res.status !== 409) {
      throw new Error(`AER abort failed: ${res.status} ${await safeText(res)}`);
    }
  }

  async function close(): Promise<void> {
    closed = true;
    clearInterval(timer);
    if (buffer.length > 0) {
      await flush();
    }
  }

  return { emit, flush, complete, abort, close };
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
