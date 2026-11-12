// HTTP client boundary for the Sentinel local-poll sensor, matching the
// real server routes in the private monorepo exactly (never an invented
// shape): POST/DELETE /v1/fleet/local-sensors[/...] (fleet-local-sensors.ts),
// GET /v1/fleet/sensors (fleet.ts - the only place a row's `claim_id` is
// returned), POST /v1/sentinel/local-poll/:id (local-poll-ingest.ts's
// `LocalPollIngestBody`, a strict `{ poller_version?, rows }` object).

import type { ObservationRow } from './types.js';
import { CLI_VERSION } from '../version.generated.js';

export interface RegisterRequest {
  device_id: string;
  consent_version: string;
  source_platform: 'linux' | 'macos';
  environment_id?: string;
  device_label?: string;
}

// Exactly the fields POST /v1/fleet/local-sensors returns (fleet-local-
// sensors.ts). There is no `expected_claim_id` here - the server never sends
// one at registration time; see getSensors() below for where a claim id
// actually comes from.
export interface RegisterResponse {
  sensor_source_id: string;
  push_token: string;
  ingest_url: string;
}

// One row of GET /v1/fleet/sensors's `sensors` array (fleet.ts). `claim_id`
// is null for a sensor whose device has no owner binding (shouldn't happen
// for a local-poll sensor, but the server's shape allows it).
export interface SensorListRow {
  sensor_source_id: string;
  kind: string;
  environment_id: string | null;
  enabled: number;
  last_ingested_at: string | null;
  device_id: string | null;
  device_label: string | null;
  claim_id: string | null;
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
   * stored observations. `expectedClaimId` must be the CURRENT claim id
   * (fetch it fresh via getSensors() - never a value cached at install
   * time: an admin reassignment mints a new claim, and a stale one must
   * 409, not silently succeed). */
  eraseObservations(sensorSourceId: string, expectedClaimId: string): Promise<void>;
  /** GET /v1/fleet/sensors - the tenant's own sensor rows, each carrying its
   * current `claim_id`. */
  getSensors(): Promise<SensorListRow[]>;
  /** POST /v1/sentinel/local-poll/:sensor_source_id - pushes a batch. */
  push(sensorSourceId: string, pushToken: string, rows: ObservationRow[]): Promise<PushResult>;
}

export interface HttpClientOptions {
  baseUrl: string;
  apiKey: string;
  fetchFn?: typeof fetch;
  /** Per-request timeout; a hung connection must never halt the daemon
   * indefinitely. Defaults to 15s. */
  timeoutMs?: number;
}

/** The one real implementation, pointed at the live API. Every call is a
 * thin, direct mapping onto the documented wire contract - no retry/backoff
 * logic here (that belongs to the daemon's outbox loop, which decides WHEN
 * to call `push` again). */
export class HttpSentinelLocalApiClient implements SentinelLocalApiClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: HttpClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchFn(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async register(req: RegisterRequest): Promise<RegisterResponse> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/v1/fleet/local-sensors`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(req),
    });
    if (!res.ok) throw new SentinelLocalApiError(`registration failed: ${res.status}`, res.status);
    return (await res.json()) as RegisterResponse;
  }

  async disable(sensorSourceId: string): Promise<void> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/v1/fleet/local-sensors/${encodeURIComponent(sensorSourceId)}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${this.apiKey}` },
    });
    if (!res.ok && res.status !== 404) throw new SentinelLocalApiError(`disable failed: ${res.status}`, res.status);
  }

  async eraseObservations(sensorSourceId: string, expectedClaimId: string): Promise<void> {
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/v1/fleet/local-sensors/${encodeURIComponent(sensorSourceId)}/observations`,
      {
        method: 'DELETE',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ expected_claim_id: expectedClaimId }),
      },
    );
    if (!res.ok) throw new SentinelLocalApiError(`erase failed: ${res.status}`, res.status);
  }

  async getSensors(): Promise<SensorListRow[]> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/v1/fleet/sensors`, {
      method: 'GET',
      headers: { authorization: `Bearer ${this.apiKey}` },
    });
    if (!res.ok) throw new SentinelLocalApiError(`list sensors failed: ${res.status}`, res.status);
    const body = (await res.json()) as { sensors: SensorListRow[] };
    return body.sensors ?? [];
  }

  async push(sensorSourceId: string, pushToken: string, rows: ObservationRow[]): Promise<PushResult> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/v1/sentinel/local-poll/${encodeURIComponent(sensorSourceId)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${pushToken}` },
      // Exactly LocalPollIngestBody's strict shape (local-poll-ingest.ts):
      // `{ poller_version?, rows }`. An extra key such as a stray
      // `observations` wrapper 400s the WHOLE batch server-side.
      body: JSON.stringify({ poller_version: CLI_VERSION, rows }),
    });
    return {
      status: res.status,
      ok: res.ok,
      retryable: res.status === 429 || res.status === 503,
    };
  }
}
