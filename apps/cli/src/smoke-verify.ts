// What `aer smoke` needs to prove a record actually came out: the key the
// collector will use, and a check against the API that a new session for the
// agent arrived and completed. A workload that exits 0 proves only that the
// workload ran; a collector with no key, a wrong base URL or a refused session
// open all exit 0 too.

/**
 * The API key the Node collector reads: AER_API_KEY, then AER_TENANT_API_KEY.
 * doctor, smoke and the collector must agree on this, or smoke passes its
 * checks and then launches a collector that has no key.
 */
export function collectorApiKey(env: Record<string, string | undefined>): string | undefined {
  return env['AER_API_KEY'] || env['AER_TENANT_API_KEY'] || undefined;
}

export interface SessionListOpts {
  baseUrl: string;
  apiKey: string;
  agentId?: string | undefined;
  fetchImpl?: typeof fetch;
}

interface SessionRow {
  agent_session_id?: unknown;
  status?: unknown;
}

async function listRows(opts: SessionListOpts): Promise<SessionRow[]> {
  const f = opts.fetchImpl ?? fetch;
  const q = new URLSearchParams();
  if (opts.agentId) q.set('agent_id', opts.agentId);
  q.set('limit', '50');
  const res = await f(`${opts.baseUrl.replace(/\/+$/, '')}/v1/sessions?${q.toString()}`, {
    headers: { authorization: `Bearer ${opts.apiKey}` },
  });
  if (!res.ok) throw new Error(`GET /v1/sessions answered ${res.status}`);
  const body = (await res.json()) as { sessions?: unknown };
  return Array.isArray(body.sessions) ? (body.sessions as SessionRow[]) : [];
}

/** Ids of the agent's newest sessions, to diff against after the workload. */
export async function listSessionIds(opts: SessionListOpts): Promise<Set<string>> {
  const rows = await listRows(opts);
  return new Set(rows.map((r) => r.agent_session_id).filter((id): id is string => typeof id === 'string'));
}

export interface AwaitNewSessionOpts extends SessionListOpts {
  before: ReadonlySet<string>;
  timeoutMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Poll until a session that was not in `before` shows up completed. Returns
 * it, or the newest new session with its last status once the time is up, or
 * null when none appeared at all.
 */
export async function awaitNewSession(opts: AwaitNewSessionOpts): Promise<{ id: string; status: string } | null> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const intervalMs = opts.intervalMs ?? 500;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // A read count rather than a deadline, so the budget holds however long
  // each read takes, and at least two reads happen whatever the budget.
  const reads = Math.max(2, Math.ceil(timeoutMs / intervalMs) + 1);
  let latest: { id: string; status: string } | null = null;
  for (let attempt = 1; ; attempt += 1) {
    const rows = await listRows(opts);
    const fresh = rows
      .filter((r) => typeof r.agent_session_id === 'string' && !opts.before.has(r.agent_session_id))
      .map((r) => ({ id: r.agent_session_id as string, status: typeof r.status === 'string' ? r.status : 'unknown' }));
    const done = fresh.find((s) => s.status === 'completed');
    if (done) return done;
    if (fresh[0]) latest = fresh[0];
    if (attempt >= reads) return latest;
    await sleep(intervalMs);
  }
}
