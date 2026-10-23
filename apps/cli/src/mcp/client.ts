// Authed HTTP client for `aer mcp serve`'s nine tools. Resolution of
// {baseUrl, apiKey} is left to resolveAuth (auth/resolve.ts), unchanged;
// this only adds the headers, client-side rate limiting and error mapping.

import { sanitizeForTerminal } from '../cli-error.js';
import { assertUncompressed } from '../http-guard.js';

export interface McpClientOptions {
  baseUrl: string;
  apiKey: string;
  clientVersion: string;
  /** Requests/minute ceiling this client enforces on itself. Default 60
   * (half the free-tier read_heavy bucket; design section 1.3/6.5), so a
   * chatty copilot cannot starve the console sharing the same tenant. */
  maxRpm?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class McpToolError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'McpToolError';
  }
}

/** Thrown when this client's own local rate ceiling (not the server's) is hit. */
export class McpLocalRateLimitError extends McpToolError {
  constructor(retryAfterSeconds: number) {
    super(
      `local rate limit: this MCP server allows at most the configured requests/min; wait ${retryAfterSeconds}s and retry`,
      'local_rate_limited',
      retryAfterSeconds,
    );
  }
}

/** Fixed-window token bucket. One instance per running `aer mcp serve` process. */
export class TokenBucket {
  private windowStart: number;
  private used = 0;
  private readonly limit: number;

  // A non-finite/non-positive limit (a bad --max-rpm that slipped past the
  // CLI's own parsing) would make every `used >= limit` check below false
  // forever, silently turning rate limiting off. Fall back to the default
  // rather than trust the caller's value blindly.
  constructor(limit: number, private readonly now: () => number = Date.now) {
    this.limit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 60;
    this.windowStart = this.now();
  }

  /** Throws McpLocalRateLimitError if the window's budget is exhausted. */
  take(): void {
    const t = this.now();
    if (t - this.windowStart >= 60_000) {
      this.windowStart = t;
      this.used = 0;
    }
    if (this.used >= this.limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((this.windowStart + 60_000 - t) / 1000));
      throw new McpLocalRateLimitError(retryAfterSeconds);
    }
    this.used += 1;
  }
}

function retryAfterFromResponse(res: Response): number | undefined {
  const header = res.headers.get('retry-after');
  if (header) {
    const n = Number(header);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return undefined;
}

async function safeJson(res: Response): Promise<Record<string, unknown>> {
  try {
    const text = await res.text();
    if (!text) return {};
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Refusal codes the API maps to non-credential 403s (design section 3.3),
 * surfaced here with a message that does not read as a crash. */
const REFUSAL_MESSAGES: Record<string, string> = {
  mcp_access_disabled: 'AER copilot access was turned off for this tenant. Ask an admin to enable it in Settings.',
  mcp_requires_read_key: 'This key\'s role is not read-only; mint or approve a read-role key for an AI assistant.',
  tenant_suspended: 'This AER workspace is paused.',
};

export class McpApiClient {
  private readonly bucket: TokenBucket;
  private readonly f: typeof fetch;
  private readonly base: string;

  constructor(private readonly opts: McpClientOptions) {
    this.bucket = new TokenBucket(opts.maxRpm ?? 60, opts.now);
    this.f = opts.fetchImpl ?? fetch;
    this.base = opts.baseUrl.replace(/\/$/, '');
  }

  /** Performs a GET (or other) request; throws McpToolError / McpLocalRateLimitError. */
  async request(path: string, init?: RequestInit): Promise<unknown> {
    this.bucket.take();
    const res = await this.f(`${this.base}${path}`, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        authorization: `Bearer ${this.opts.apiKey}`,
        'user-agent': `aer-cli/${this.opts.clientVersion}`,
        'x-aer-client': `aer-mcp/${this.opts.clientVersion}`,
      },
    });
    await assertUncompressed(res);

    if (res.status === 429) {
      const retryAfterSeconds = retryAfterFromResponse(res);
      throw new McpToolError(
        `rate limited by the API${retryAfterSeconds !== undefined ? `; retry in ${retryAfterSeconds}s` : ''}`,
        'rate_limited',
        retryAfterSeconds,
      );
    }

    if (!res.ok) {
      const body = await safeJson(res);
      const code = typeof body['error'] === 'string' ? body['error'] : undefined;
      const friendly = code ? REFUSAL_MESSAGES[code] : undefined;
      if (friendly) throw new McpToolError(friendly, code);
      const message = typeof body['message'] === 'string' ? body['message'] : `HTTP ${res.status}`;
      throw new McpToolError(sanitizeForTerminal(message, 500), code ?? `http_${res.status}`);
    }

    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  async get(path: string): Promise<unknown> {
    return this.request(path);
  }
}
