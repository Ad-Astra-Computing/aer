// OAuth 2.0 device authorization grant (RFC 8628 shape) client for `aer login`.
// POST /v1/cli/device starts a grant; POST /v1/cli/device/token polls it.
// `verification_uri_complete` is never used: the code must be typed, never
// prefilled, so only the plain `verification_uri` is shown or opened.

import { sanitizeForTerminal } from '../cli-error.js';

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
const RESPONSE_TEXT_CAP = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ALLOWED_ROLES = new Set(['read', 'write']);
const MIN_INTERVAL_S = 1;
const MAX_INTERVAL_S = 60;
const MIN_EXPIRES_IN_S = 1;
const MAX_EXPIRES_IN_S = 900;

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

/** Truncated, control-character-free response text for error messages: a
 * misconfigured or hostile base URL must never flood or corrupt the
 * terminal. */
async function safeResponseText(res: Response): Promise<string> {
  try {
    return sanitizeForTerminal(await res.text(), RESPONSE_TEXT_CAP);
  } catch {
    return '';
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/**
 * The verification URL is untrusted server input handed to a shell-adjacent
 * browser-open call and printed to the terminal, so it is parsed and pinned
 * to https (http only for loopback) with no embedded userinfo before it is
 * ever shown or opened. Returns the canonical `href`.
 */
export function validateVerificationUri(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DeviceLoginError('the login server returned an invalid verification URL');
  }
  if (url.username || url.password) {
    throw new DeviceLoginError('the login server returned a verification URL with embedded credentials, refusing it');
  }
  const isLoopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
  const isHttpsOrLoopbackHttp = url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback);
  if (!isHttpsOrLoopbackHttp) {
    throw new DeviceLoginError('the login server returned a verification URL that is not https, refusing it');
  }
  return url.href;
}

/** Validates and normalizes the /v1/cli/device response before it is ever
 * shown, opened, or polled against. */
function parseStartResponse(body: Record<string, unknown>): DeviceStartResponse {
  const deviceCode = typeof body['device_code'] === 'string' ? body['device_code'] : '';
  if (!deviceCode) throw new DeviceLoginError('the login server did not return a device_code');

  const userCode = typeof body['user_code'] === 'string' ? body['user_code'] : '';
  if (!userCode) throw new DeviceLoginError('the login server did not return a user_code');

  const verificationUri = validateVerificationUri(
    typeof body['verification_uri'] === 'string' ? body['verification_uri'] : '',
  );
  const verificationUriComplete = typeof body['verification_uri_complete'] === 'string'
    ? body['verification_uri_complete']
    : '';

  const rawExpiresIn = Number(body['expires_in']);
  const expiresIn = Number.isFinite(rawExpiresIn) ? clamp(rawExpiresIn, MIN_EXPIRES_IN_S, MAX_EXPIRES_IN_S) : 600;

  const rawInterval = Number(body['interval']);
  const interval = Number.isFinite(rawInterval) ? clamp(rawInterval, MIN_INTERVAL_S, MAX_INTERVAL_S) : 5;

  return {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: verificationUri,
    verification_uri_complete: verificationUriComplete,
    expires_in: expiresIn,
    interval,
  };
}

/** Validates the grant the server hands back on success, before it is ever
 * stored: a non-empty key/key_id, a UUID tenant_id, a role within the CLI's
 * ceiling (never admin, matching the design's "never admin from this flow"),
 * and a parseable expires_at. */
function parseGrant(body: Record<string, unknown>): DeviceLoginResult {
  const apiKey = typeof body['api_key'] === 'string' ? body['api_key'] : '';
  if (!apiKey) throw new DeviceLoginError('the login server did not return an api_key');

  const keyId = typeof body['key_id'] === 'string' ? body['key_id'] : '';
  if (!keyId) throw new DeviceLoginError('the login server did not return a key_id');

  const tenantId = typeof body['tenant_id'] === 'string' ? body['tenant_id'] : '';
  if (!UUID_RE.test(tenantId)) throw new DeviceLoginError('the login server returned a malformed tenant_id');

  const role = typeof body['role'] === 'string' ? body['role'] : '';
  if (!ALLOWED_ROLES.has(role)) throw new DeviceLoginError(`the login server returned an unexpected role: ${sanitizeForTerminal(role, 40)}`);

  const expiresAt = typeof body['expires_at'] === 'string' ? body['expires_at'] : '';
  if (!expiresAt || Number.isNaN(Date.parse(expiresAt))) {
    throw new DeviceLoginError('the login server returned an unparsable expires_at');
  }

  return { api_key: apiKey, key_id: keyId, tenant_id: tenantId, role, expires_at: expiresAt };
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
  if (!res.ok) {
    const body = await readJson(res);
    const errorCode = typeof body['error'] === 'string' ? body['error'] : undefined;
    throw new DeviceLoginError(
      `could not start login (HTTP ${res.status}): ${errorCode ? sanitizeForTerminal(errorCode, RESPONSE_TEXT_CAP) : 'unknown error'}`,
      errorCode,
    );
  }
  return parseStartResponse(await readJson(res));
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
      return parseGrant(await readJson(res));
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
      throw new DeviceLoginError(
        `unexpected response from the login server: ${error ? sanitizeForTerminal(error, RESPONSE_TEXT_CAP) : await safeResponseText(res)}`,
        error,
      );
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
