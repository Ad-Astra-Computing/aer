// OAuth 2.0 device authorization grant (RFC 8628 shape) client for `aer login`.
// POST /v1/cli/device starts a grant; POST /v1/cli/device/token polls it.
// `verification_uri_complete` is never used: the code must be typed, never
// prefilled, so only the plain `verification_uri` is shown or opened.

export interface DeviceStartResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface DeviceLoginResult {
  api_key: string;
  key_id: string;
  tenant_id: string;
  role: string;
  expires_at: string;
}

export class DeviceLoginError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = 'DeviceLoginError';
  }
}

export interface DeviceLoginOptions {
  baseUrl: string;
  client: string;
  hostname?: string | undefined;
  fetchImpl?: typeof fetch;
  /** Injectable sleep so tests run instantly instead of waiting real seconds. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock so the expiry deadline is deterministic in tests. */
  now?: () => number;
  /** Called once with the fields the caller should show the person. */
  onPrompt?: (start: DeviceStartResponse) => void;
  /** Called before each poll attempt, useful for tests asserting on timing. */
  onPoll?: (attempt: number) => void;
}

const RATE_LIMIT_BACKOFF_MS = 5000;

function trimUrl(u: string): string {
  return u.replace(/\/+$/, '');
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    const text = await res.text();
    if (!text) return {};
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function startDeviceLogin(opts: DeviceLoginOptions): Promise<DeviceStartResponse> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(`${trimUrl(opts.baseUrl)}/v1/cli/device`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client: opts.client,
      ...(opts.hostname ? { hostname: opts.hostname } : {}),
    }),
  });
  const body = await readJson(res);
  if (!res.ok) {
    throw new DeviceLoginError(
      `could not start login (HTTP ${res.status}): ${String(body['error'] ?? 'unknown error')}`,
      typeof body['error'] === 'string' ? body['error'] : undefined,
    );
  }
  return body as unknown as DeviceStartResponse;
}

/**
 * Polls `/v1/cli/device/token` until the grant is approved, denied, expired,
 * or the local deadline (start.expires_in) passes. Resolves exactly once, on
 * the single 201 response the server ever sends for a device_code.
 */
export async function pollForToken(
  start: DeviceStartResponse,
  opts: DeviceLoginOptions,
): Promise<DeviceLoginResult> {
  const f = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const base = trimUrl(opts.baseUrl);

  let intervalMs = Math.max(1, start.interval) * 1000;
  const deadline = now() + start.expires_in * 1000;
  let attempt = 0;

  for (;;) {
    if (now() >= deadline) {
      throw new DeviceLoginError('the login request expired, run `aer login` again', 'expired_token');
    }
    await sleep(intervalMs);
    attempt += 1;
    opts.onPoll?.(attempt);

    const res = await f(`${base}/v1/cli/device/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_code: start.device_code }),
    });

    if (res.status === 201) {
      const body = await readJson(res);
      return body as unknown as DeviceLoginResult;
    }

    const body = await readJson(res);
    const error = typeof body['error'] === 'string' ? body['error'] : undefined;

    if (res.status === 400) {
      if (error === 'authorization_pending') continue;
      if (error === 'slow_down') {
        intervalMs += RATE_LIMIT_BACKOFF_MS;
        continue;
      }
      if (error === 'access_denied') {
        throw new DeviceLoginError('the login request was denied', 'access_denied');
      }
      if (error === 'expired_token') {
        throw new DeviceLoginError('the login request expired, run `aer login` again', 'expired_token');
      }
      throw new DeviceLoginError(`unexpected response from the login server: ${error ?? 'unknown error'}`, error);
    }

    if (res.status === 403 && error === 'cli_device_key_limit_reached') {
      throw new DeviceLoginError(
        'too many CLI logins are already active for your account; revoke one in Settings and try again',
        error,
      );
    }

    if (res.status === 429) {
      // Back off harder than the server's own interval and keep polling; this
      // still counts against the overall deadline above.
      intervalMs += RATE_LIMIT_BACKOFF_MS;
      continue;
    }

    throw new DeviceLoginError(`unexpected response from the login server (HTTP ${res.status})`);
  }
}

export async function runDeviceLogin(opts: DeviceLoginOptions): Promise<DeviceLoginResult> {
  const start = await startDeviceLogin(opts);
  opts.onPrompt?.(start);
  return pollForToken(start, opts);
}

/** "ABCDEFGH" -> "ABCD-EFGH"; leaves an already-dashed code untouched. */
export function formatUserCode(code: string): string {
  const compact = code.replace(/-/g, '').toUpperCase();
  if (compact.length <= 4) return compact;
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

const MAX_HOSTNAME_LEN = 64;
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

/** os.hostname(), stripped of control characters and capped at 64 bytes of display text. */
export function sanitizeHostname(raw: string): string {
  return raw.replace(CONTROL_CHARS, '').slice(0, MAX_HOSTNAME_LEN);
}
