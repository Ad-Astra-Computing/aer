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

export interface IngestSummary {
  accepted: number;
  rejected: number;
  parseErrors: number;
  batches: number;
}

export async function ingestJsonlStream(opts: IngestOptions): Promise<IngestSummary> {
  const baseUrl = opts.baseUrl.replace(/\/$/, '');
  const batchSize = opts.batchSize ?? 500;
  const fetchImpl = opts.fetchImpl ?? fetch;

  const summary: IngestSummary = { accepted: 0, rejected: 0, parseErrors: 0, batches: 0 };
  const buffer: unknown[] = [];

  async function flush(): Promise<void> {
    if (buffer.length === 0) return;
    const chunk = buffer.splice(0, buffer.length);
    const res = await fetchImpl(`${baseUrl}/v1/sessions/${opts.sessionId}/events`, {
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
    const body = (await res.json()) as { accepted: number; rejected: number };
    summary.accepted += body.accepted;
    summary.rejected += body.rejected;
    summary.batches += 1;
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

  return summary;
}
