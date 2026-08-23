import type { Readable } from 'node:stream';
import { createInterface } from 'node:readline';
import { claudeCodeTranscriptToEvents, type TranscriptCtx } from './claude-code.js';

// H4 - end-to-end Claude Code transcript import. Reads a session JSONL transcript,
// creates an AER session, maps entries to bodies-off events on the CLIENT, POSTs
// them through the normal ingest path, then completes the session (generating the
// signed AER). The transcript never leaves the machine except as bodies-off events.

export interface ImportRunOptions {
  stream: Readable;
  baseUrl: string;
  /** Tenant API key — creates the session (write role). */
  apiKey: string;
  tenantId: string;
  agentId: string;
  environmentId: string;
  agentVersion?: string;
  /** Cap on transcript lines read into memory (bounds allocation). Default 1M. */
  maxEntries?: number;
  /** Cap on emitted events (passed to the mapper). Default from the mapper. */
  maxEvents?: number;
  /** Events POSTed per request. Default 500. */
  batchSize?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export interface ImportRunSummary {
  session_id: string;
  entries_read: number;
  entries_truncated: boolean;
  imported_events: number;
  events_truncated: boolean;
  accepted: number;
  rejected: number;
  aer_id?: string;
}

const DEFAULT_MAX_ENTRIES = 1_000_000;

export async function runClaudeCodeImport(opts: ImportRunOptions): Promise<ImportRunSummary> {
  const baseUrl = opts.baseUrl.replace(/\/$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const batchSize = opts.batchSize ?? 500;
  const nowIso = (opts.now ?? (() => new Date()))().toISOString();

  // 1. Read + parse the transcript (bounded). Correlation across tool_use /
  //    tool_result spans the whole file, so we map in one pass over all entries.
  const entries: unknown[] = [];
  let entriesTruncated = false;
  const rl = createInterface({ input: opts.stream, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (entries.length >= maxEntries) { entriesTruncated = true; break; }
    try { entries.push(JSON.parse(trimmed)); } catch { /* skip malformed line */ }
  }

  // 2. Create the session (tenant auth).
  const createRes = await fetchImpl(`${baseUrl}/v1/sessions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${opts.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      tenant_id: opts.tenantId,
      agent_id: opts.agentId,
      agent_version: opts.agentVersion ?? 'transcript-import',
      environment_id: opts.environmentId,
      metadata: { imported_from: 'claude-code' },
    }),
  });
  if (createRes.status !== 201) {
    throw new Error(`session create failed: ${createRes.status} ${await safeText(createRes)}`);
  }
  const created = (await createRes.json()) as { agent_session_id: string; ingest_token: string };
  const sessionId = created.agent_session_id;
  const token = created.ingest_token;

  // 3. Map to bodies-off events.
  const ctx: TranscriptCtx = {
    sessionId,
    now: nowIso,
    ...(opts.maxEvents !== undefined ? { maxEvents: opts.maxEvents } : {}),
  };
  const { events, truncated: eventsTruncated } = claudeCodeTranscriptToEvents(entries, ctx);

  // 4. POST events in batches through the normal ingest path.
  let accepted = 0;
  let rejected = 0;
  for (let i = 0; i < events.length; i += batchSize) {
    const chunk = events.slice(i, i + batchSize);
    const res = await fetchImpl(`${baseUrl}/v1/sessions/${sessionId}/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(chunk),
    });
    if (!(res.status === 202 || res.status === 207)) {
      throw new Error(`event ingest failed: ${res.status} ${await safeText(res)}`);
    }
    const body = (await res.json()) as { accepted?: number; rejected?: number };
    accepted += body.accepted ?? 0;
    rejected += body.rejected ?? 0;
  }

  // 5. Complete the session → generates the signed AER.
  let aerId: string | undefined;
  const completeRes = await fetchImpl(`${baseUrl}/v1/sessions/${sessionId}/complete`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: '{}',
  });
  if (completeRes.status === 200 || completeRes.status === 201) {
    const done = (await completeRes.json().catch(() => null)) as { aer_id?: string } | null;
    if (done?.aer_id) aerId = done.aer_id;
  }

  return {
    session_id: sessionId,
    entries_read: entries.length,
    entries_truncated: entriesTruncated,
    imported_events: events.length,
    events_truncated: eventsTruncated,
    accepted,
    rejected,
    ...(aerId ? { aer_id: aerId } : {}),
  };
}

async function safeText(res: Response): Promise<string> {
  try { return (await res.text()).slice(0, 200); } catch { return ''; }
}
