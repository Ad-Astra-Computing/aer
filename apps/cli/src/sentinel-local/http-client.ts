// HTTP client boundary for the Sentinel local-poll sensor. The server routes
// (/v1/fleet/local-sensors, the ingest route) don't exist yet: this is the
// interface boundary every caller depends on, so wiring in
// HttpSentinelLocalApiClient once they ship is a one-line swap, not a
// redesign. TODO(server): confirm the exact registration shape against the
// real route; this follows the design doc's documented fields.

import type { ObservationRow } from './types.js';

export interface RegisterRequest {
  device_id: string;
  consent_version: string;
  source_platform: 'linux' | 'macos';
  environment_id?: string;
  device_label?: string;
}

export interface RegisterResponse {
  sensor_source_id: string;
  push_token: string;
  ingest_url: string;
  /** Stamped on every ownership-establishing write; captured so a later
   * `uninstall --erase` can pass it back as `expected_claim_id`. */
  expected_claim_id: string;
}

export interface PushResult {
  status: number;
  /** True for a 2xx response. */
  ok: boolean;
  /** True for 429/503 - caller backs off exponentially. */
  retryable: boolean;
}

export class SentinelLocalApiError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'SentinelLocalApiError';
  }
}

export interface SentinelLocalApiClient {
  register(req: RegisterRequest): Promise<RegisterResponse>;
  /** DELETE /v1/fleet/local-sensors/:id - disables the registration. */
  disable(sensorSourceId: string): Promise<void>;
  /** DELETE /v1/fleet/local-sensors/:id/observations - erases this device's
   * stored observations. Requires the claim_id captured at registration. */
  eraseObservations(sensorSourceId: string, expectedClaimId: string): Promise<void>;
  /** POST /v1/sentinel/local-poll/:sensor_source_id - pushes a batch. */
  push(sensorSourceId: string, pushToken: string, rows: ObservationRow[]): Promise<PushResult>;
}

export interface HttpClientOptions {
  baseUrl: string;
  apiKey: string;
  fetchFn?: typeof fetch;
}

/** The one real implementation, pointed at the live API once the server
 * routes ship. Every call is a thin, direct mapping onto the documented wire
 * contract - no retry/backoff logic here (that belongs to the daemon's
 * outbox loop, which decides WHEN to call `push` again). */
export class HttpSentinelLocalApiClient implements SentinelLocalApiClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchFn: typeof fetch;

  constructor(opts: HttpClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  async register(req: RegisterRequest): Promise<RegisterResponse> {
    const res = await this.fetchFn(`${this.baseUrl}/v1/fleet/local-sensors`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(req),
    });
    if (!res.ok) throw new SentinelLocalApiError(`registration failed: ${res.status}`, res.status);
    return (await res.json()) as RegisterResponse;
  }

  async disable(sensorSourceId: string): Promise<void> {
    const res = await this.fetchFn(`${this.baseUrl}/v1/fleet/local-sensors/${encodeURIComponent(sensorSourceId)}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${this.apiKey}` },
    });
    if (!res.ok && res.status !== 404) throw new SentinelLocalApiError(`disable failed: ${res.status}`, res.status);
  }

  async eraseObservations(sensorSourceId: string, expectedClaimId: string): Promise<void> {
    const res = await this.fetchFn(
      `${this.baseUrl}/v1/fleet/local-sensors/${encodeURIComponent(sensorSourceId)}/observations`,
      {
        method: 'DELETE',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ expected_claim_id: expectedClaimId }),
      },
    );
    if (!res.ok) throw new SentinelLocalApiError(`erase failed: ${res.status}`, res.status);
  }

  async push(sensorSourceId: string, pushToken: string, rows: ObservationRow[]): Promise<PushResult> {
    const res = await this.fetchFn(`${this.baseUrl}/v1/sentinel/local-poll/${encodeURIComponent(sensorSourceId)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${pushToken}` },
      body: JSON.stringify({ observations: rows }),
    });
    return {
      status: res.status,
      ok: res.ok,
      retryable: res.status === 429 || res.status === 503,
    };
  }
}
