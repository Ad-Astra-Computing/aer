import type { Readable } from 'node:stream';
import { createInterface } from 'node:readline';

export interface IngestOptions {
  stream: Readable;
  baseUrl: string;
  sessionId: string;
  token: string;
  batchSize?: number;
  fetchImpl?: typeof fetch;
}

// One rejected event's detail, trimmed to what a user needs to fix their
// fixture: which line and why. Never the full Zod issue list (that can be
// large and is available by hitting the gateway directly if truly needed).
export interface IngestErrorSample {
  index: number;
  message: string;
}

export interface IngestSummary {
  accepted: number;
  rejected: number;
  parseErrors: number;
  batches: number;
  errors?: IngestErrorSample[];
}

// Cap on how many per-event error samples the summary carries, so a batch
// that rejects everything does not turn the summary into a wall of text.
const MAX_ERROR_SAMPLES = 5;

interface ServerBatchIssue {
  index: number;
  issues?: Array<{ message?: string }>;
}

export async function ingestJsonlStream(opts: IngestOptions): Promise<IngestSummary> {
  const baseUrl = opts.baseUrl.replace(/\/$/, '');
  const batchSize = opts.batchSize ?? 500;
  const fetchImpl = opts.fetchImpl ?? fetch;

  const summary: IngestSummary = { accepted: 0, rejected: 0, parseErrors: 0, batches: 0 };
  const errorSamples: IngestErrorSample[] = [];
  const buffer: unknown[] = [];

  async function flush(): Promise<void> {
    if (buffer.length === 0) return;
    const chunk = buffer.splice(0, buffer.length);
    const res = await fetchImpl(`${baseUrl}/v1/sessions/${encodeURIComponent(opts.sessionId)}/events`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${opts.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(chunk),
    });
    if (!(res.status === 202 || res.status === 207)) {
      throw new Error(`ingest failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { accepted: number; rejected: number; errors?: ServerBatchIssue[] };
    summary.accepted += body.accepted;
    summary.rejected += body.rejected;
    summary.batches += 1;
    if (Array.isArray(body.errors)) {
      for (const e of body.errors) {
        if (errorSamples.length >= MAX_ERROR_SAMPLES) break;
        const message = e.issues?.[0]?.message ?? 'validation failed';
        errorSamples.push({ index: e.index, message });
      }
    }
  }

  const rl = createInterface({ input: opts.stream, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      buffer.push(JSON.parse(trimmed));
    } catch {
      summary.parseErrors += 1;
      continue;
    }
    if (buffer.length >= batchSize) await flush();
  }
  await flush();

  if (errorSamples.length > 0) summary.errors = errorSamples;
  return summary;
}
