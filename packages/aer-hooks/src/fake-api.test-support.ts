// An in-process stand-in for the AER session API, for driving runHook in
// tests. It keeps the server rules the hook depends on: a client_ref reuses a
// RUNNING session and mints a fresh token for it (at most 16), a closed
// session frees its client_ref, events to a closed session get 409, and a
// re-sent event_id is stored once.

export interface FakeSession {
  id: string;
  status: 'running' | 'completed';
  clientRef: string | undefined;
  tokens: Set<string>;
  events: Array<{ event_id: string; event_type: string; payload: Record<string, unknown> }>;
  openBody: Record<string, unknown>;
}

export interface Fault {
  method?: string;
  path: RegExp;
  status: number;
  body?: Record<string, unknown>;
  times?: number;
}

export interface Request {
  method: string;
  path: string;
  at: number;
  body: unknown;
}

const MAX_TOKENS_PER_SESSION = 16;

export class FakeApi {
  readonly sessions = new Map<string, FakeSession>();
  readonly requests: Request[] = [];
  openDelayMs = 0;
  eventsDelayMs = 0;
  completeDelayMs = 0;
  /** Called at the start of every request, for tests that inspect local state mid-flight. */
  onRequest: ((method: string, path: string) => void) | undefined;
  private faults: Fault[] = [];
  private nextId = 1;
  private nextToken = 1;

  fault(f: Fault): void {
    this.faults.push({ times: Infinity, ...f });
  }

  readonly fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const path = url.pathname;
    let body: unknown;
    try {
      body = init?.body ? JSON.parse(String(init.body)) : undefined;
    } catch {
      body = undefined;
    }
    this.requests.push({ method, path, at: Date.now(), body });
    this.onRequest?.(method, path);

    // The server does the work and then the answer travels back: a caller
    // that gives up while waiting leaves the work done and the answer lost.
    const delay = path === '/v1/sessions' ? this.openDelayMs : path.endsWith('/events') ? this.eventsDelayMs : this.completeDelayMs;
    const response = this.handle(method, path, body, init);
    if (delay > 0) await sleepOrAbort(delay, init?.signal ?? undefined);
    return response;
  }) as typeof fetch;

  private handle(method: string, path: string, body: unknown, init: RequestInit | undefined): Response {
    const fault = this.faults.find((f) => (f.method === undefined || f.method === method) && f.path.test(path) && (f.times ?? 0) > 0);
    if (fault) {
      fault.times = (fault.times ?? 0) - 1;
      return json(fault.body ?? { error: `fault_${fault.status}` }, fault.status);
    }

    if (method === 'POST' && path === '/v1/sessions') return this.open(body as Record<string, unknown>);
    const m = /^\/v1\/sessions\/([^/]+)\/(events|complete)$/.exec(path);
    if (method === 'POST' && m) {
      const s = this.sessions.get(m[1]!);
      if (!s) return json({ error: 'session_not_found' }, 404);
      const bearer = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '') ?? '';
      if (!s.tokens.has(bearer)) return json({ error: 'unauthorized' }, 401);
      if (s.status !== 'running') return json({ error: 'session_not_running', status: s.status }, 409);
      if (m[2] === 'complete') {
        s.status = 'completed';
        return json({ aer_id: `aer-${s.id}` }, 200);
      }
      if (!Array.isArray(body)) return json({ error: 'expected_array' }, 400);
      let accepted = 0;
      for (const e of body as FakeSession['events']) {
        if (s.events.some((x) => x.event_id === e.event_id)) continue;
        s.events.push(e);
        accepted += 1;
      }
      return json({ accepted, rejected: 0 }, 200);
    }
    return json({ error: 'not_found' }, 404);
  }

  private open(body: Record<string, unknown>): Response {
    // The real API's CreateSessionRequest requires both.
    if (typeof body?.['agent_version'] !== 'string' || typeof body?.['environment_id'] !== 'string') {
      return json({ error: 'invalid_request' }, 400);
    }
    const clientRef = typeof body?.['client_ref'] === 'string' ? (body['client_ref'] as string) : undefined;
    if (clientRef !== undefined) {
      const running = [...this.sessions.values()].find((s) => s.clientRef === clientRef && s.status === 'running');
      if (running) {
        if (running.tokens.size >= MAX_TOKENS_PER_SESSION) return json({ error: 'client_ref_exhausted' }, 409);
        const token = `tok-${this.nextToken++}`;
        running.tokens.add(token);
        return json({ agent_session_id: running.id, ingest_token: token, reused: true }, 200);
      }
    }
    const id = `sess-${this.nextId++}`;
    const token = `tok-${this.nextToken++}`;
    this.sessions.set(id, { id, status: 'running', clientRef, tokens: new Set([token]), events: [], openBody: body });
    return json({ agent_session_id: id, ingest_token: token }, 201);
  }

  /** Close a session the way the server watchdog does. */
  terminate(id: string): void {
    const s = this.sessions.get(id);
    if (s) s.status = 'completed';
  }

  opens(): Request[] {
    return this.requests.filter((r) => r.method === 'POST' && r.path === '/v1/sessions');
  }

  completes(): Request[] {
    return this.requests.filter((r) => r.path.endsWith('/complete'));
  }

  eventPosts(): Request[] {
    return this.requests.filter((r) => r.path.endsWith('/events'));
  }

  /** Every stored event across sessions, in arrival order. */
  allEvents(): Array<FakeSession['events'][number] & { session: string }> {
    return [...this.sessions.values()].flatMap((s) => s.events.map((e) => ({ ...e, session: s.id })));
  }

  eventsOf(type: string): Array<FakeSession['events'][number] & { session: string }> {
    return this.allEvents().filter((e) => e.event_type === type);
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function sleepOrAbort(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('aborted', 'AbortError'));
    });
  });
}
