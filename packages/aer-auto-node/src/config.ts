// Configuration resolution for the AER auto-instrumentation collector.
//
// Precedence: env overrides > aer.config.json > built-in defaults.
// The ONLY secret is AER_API_KEY, which comes exclusively from the environment
// and is never read from (or written to) the config file. All non-secret
// identity (tenant/agent/env/base_url) lives in the config file, with optional
// env overrides for CI.

export type SessionStrategy = 'process' | 'task' | 'server';

export interface SessionConfig {
  strategy: SessionStrategy;
  eager: boolean;
  requireTask: boolean;
}

export interface CaptureConfig {
  transport: string[];
  adapters: string[];
  headers: boolean;
  bodies: boolean;
  redact_query: boolean;
  redact_args: boolean;
  max_queue: number;
  max_event_bytes: number;
}

/**
 * The identity a run acted on behalf of (roadmap P1). Opaque `id` (an IdP
 * subject or employee id, never an email), a closed `kind` and an optional
 * short `display` label for feeds. Whatever you supply is signed into the AER
 * bundle, so keep it opaque.
 */
export type PrincipalKind = 'user' | 'service' | 'ci';
export interface Principal {
  id: string;
  kind: PrincipalKind;
  display?: string | undefined;
}

const PRINCIPAL_KINDS: readonly PrincipalKind[] = ['user', 'service', 'ci'];

export interface AerAutoConfig {
  disabled: boolean;
  tenantId?: string | undefined;
  agentId?: string | undefined;
  envId?: string | undefined;
  agentVersion: string;
  baseUrl: string;
  apiKey?: string | undefined;
  /**
   * Customer-held content-commitment key (ADR-011). Secret: env only
   * (AER_COMMITMENT_KEY). When set (>= 32 bytes as hex/base64), the collector
   * HMACs each recognized LLM request/response under it and emits commitment
   * tags. When absent, NO commitments are emitted (no bare-hash fallback).
   */
  commitmentKey?: string | undefined;
  session: SessionConfig;
  capture: CaptureConfig;
  /** Protected resources to present an AER Attestation token to (2b). */
  protectedResources: ProtectedResource[];
  /** Identity the run acts on behalf of (P1). Absent when unconfigured. */
  principal?: Principal | undefined;
}

/**
 * Build a Principal from raw env/file values. Returns undefined when no id is
 * given (principal is always optional). `kind` defaults to 'user' when absent
 * or not one of the closed set, so a misconfigured kind never blocks a run or
 * ships an invalid value. `id` is capped at 128 and `display` at 64 to match
 * the API, so an oversized value is rejected up front rather than by the server.
 */
export function resolvePrincipal(
  id: unknown,
  kind: unknown,
  display: unknown,
): Principal | undefined {
  const pid = asString(id);
  if (!pid || pid.length > 128) return undefined;
  const pkind = PRINCIPAL_KINDS.includes(kind as PrincipalKind) ? (kind as PrincipalKind) : 'user';
  const pdisplay = asString(display);
  return {
    id: pid,
    kind: pkind,
    ...(pdisplay && pdisplay.length <= 64 ? { display: pdisplay } : {}),
  };
}

/**
 * How the collector treats outbound requests to a protected resource (Phase 3
 * M2). `off` is today's purely-additive behavior. `report` and `block` opt the
 * resource into egress enforcement. Staged rollout: off → report → block.
 */
export type EgressEnforcement = 'off' | 'report' | 'block';

/** What block mode does when a token cannot be minted (AER API unreachable). */
export type EgressOnUnavailable = 'fail_open' | 'fail_closed';

export interface ProtectedResource {
  /** Exact host or a suffix (e.g. ".internal.example") to match request hosts. */
  host: string;
  /** Token audience to mint for this resource (e.g. mcp://payments-prod). */
  audience: string;
  /**
   * Scopes to request when minting for this resource (Phase 3). Normalized
   * (lowercase, deduped, sorted). The server downscopes to what policy grants, so
   * this can only ever narrow authority. Empty = audience-only (no scopes). In
   * block/report mode these are ALSO the scopes a token must carry to be allowed
   * out; a token missing any of them is treated as no valid attestation.
   */
  scopes: string[];
  /** Egress enforcement mode. Defaults to `off` (additive, never blocks). */
  enforcement: EgressEnforcement;
  /**
   * Block-mode behavior when minting is unavailable (API down). `fail_closed`
   * (default) denies the request; `fail_open` lets it through and logs. Mirrors
   * the resource-side guard's onUnavailable knob.
   */
  onUnavailable: EgressOnUnavailable;
  /**
   * Bind tokens for this resource to a per-session DPoP key and attach a proof to
   * each request (Phase 3 M3). Default false. When true the mint carries the key
   * thumbprint (cnf.jkt) and every request to this host gets a `DPoP` header, so a
   * stolen token cannot be replayed elsewhere. The resource must also requireDpop.
   */
  dpop: boolean;
}

// A scope label: starts alphanumeric, then [a-z0-9._:-], ≤64. Mirrors the
// server's grammar so a malformed config entry is dropped here, not sent.
const SCOPE_RE = /^[a-z0-9][a-z0-9._:-]{0,63}$/;

/** Normalize an untrusted scope list (config is lenient: drop malformed, never throw). */
export function normalizeScopeList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const s = v.trim().toLowerCase();
    if (s && SCOPE_RE.test(s)) seen.add(s);
  }
  return [...seen].sort();
}

export interface ResolveOptions {
  /** Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Parsed contents of `aer.config.json`, if present. */
  configFile?: Record<string, unknown> | null;
}

const DEFAULT_BASE_URL = 'https://api.aer.run';

const DEFAULT_CAPTURE: CaptureConfig = {
  transport: ['fetch', 'http', 'https', 'child_process'],
  adapters: ['openai', 'anthropic', 'vercel'],
  headers: false,
  bodies: false,
  redact_query: true,
  redact_args: true,
  max_queue: 10_000,
  max_event_bytes: 16_384,
};

const DEFAULT_SESSION: SessionConfig = {
  strategy: 'process',
  eager: false,
  requireTask: false,
};

function asBool(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (v === '1' || v === 'true') return true;
  if (v === '0' || v === 'false') return false;
  return fallback;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function resolveConfig(opts: ResolveOptions = {}): AerAutoConfig {
  const env = opts.env ?? {};
  const file = opts.configFile ?? {};

  const fileSession = (file['session'] ?? {}) as Partial<SessionConfig>;
  const fileCapture = (file['capture'] ?? {}) as Partial<CaptureConfig>;

  return {
    disabled: asBool(env['AER_DISABLE'], false),
    tenantId: asString(env['AER_TENANT_ID']) ?? asString(file['tenant_id']),
    agentId: asString(env['AER_AGENT_ID']) ?? asString(file['agent_id']),
    envId: asString(env['AER_ENV_ID']) ?? asString(file['env_id']),
    agentVersion:
      asString(env['AER_AGENT_VERSION']) ?? asString(file['agent_version']) ?? '0.0.0',
    baseUrl:
      asString(env['AER_BASE_URL']) ?? asString(file['base_url']) ?? DEFAULT_BASE_URL,
    // Secret: env only. Never sourced from the config file.
    apiKey: asString(env['AER_API_KEY']),
    // Secret: env only. Never sourced from the config file.
    commitmentKey: asString(env['AER_COMMITMENT_KEY']),
    session: {
      strategy: (fileSession.strategy as SessionStrategy) ?? DEFAULT_SESSION.strategy,
      eager: asBool(fileSession.eager, DEFAULT_SESSION.eager),
      requireTask: asBool(fileSession.requireTask, DEFAULT_SESSION.requireTask),
    },
    capture: { ...DEFAULT_CAPTURE, ...fileCapture },
    protectedResources: parseProtectedResources(file['protected_resources']),
    principal: resolvePrincipal(
      env['AER_PRINCIPAL_ID'] ?? (file['principal'] as Record<string, unknown> | undefined)?.['id'],
      env['AER_PRINCIPAL_KIND'] ?? (file['principal'] as Record<string, unknown> | undefined)?.['kind'],
      env['AER_PRINCIPAL_DISPLAY'] ?? (file['principal'] as Record<string, unknown> | undefined)?.['display'],
    ),
  };
}

/**
 * Resolve the attestation audience for a request host, or null if the host is
 * not a configured protected resource. Matches exact host, subdomain of a bare
 * configured host, or a leading-dot suffix entry. (Port is ignored.)
 */
export function audienceForHost(host: string, resources: ProtectedResource[]): string | null {
  return resourceForHost(host, resources)?.audience ?? null;
}

/** Like {@link audienceForHost}, but returns the whole matched resource (M2 needs its enforcement). */
export function resourceForHost(host: string, resources: ProtectedResource[]): ProtectedResource | null {
  // Normalize: lowercase, drop a port, and strip a single FQDN trailing dot
  // ("mcp.internal." resolves to the same host as "mcp.internal").
  const h = host.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  for (const r of resources) {
    if (h === r.host) return r;
    if (r.host.startsWith('.') && (h.endsWith(r.host) || h === r.host.slice(1))) return r;
    if (!r.host.startsWith('.') && h.endsWith(`.${r.host}`)) return r;
  }
  return null;
}

/** Parse an untrusted enforcement value; anything unrecognized falls back to `off`. */
function parseEnforcement(raw: unknown): EgressEnforcement {
  return raw === 'block' || raw === 'report' ? raw : 'off';
}

/** Parse an untrusted onUnavailable value; default is the secure `fail_closed`. */
function parseOnUnavailable(raw: unknown): EgressOnUnavailable {
  return raw === 'fail_open' ? 'fail_open' : 'fail_closed';
}

function parseProtectedResources(raw: unknown): ProtectedResource[] {
  if (!Array.isArray(raw)) return [];
  const out: ProtectedResource[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const host = asString(e['host']);
    const audience = asString(e['audience']);
    const scopes = normalizeScopeList(e['scopes']);
    const enforcement = parseEnforcement(e['enforcement']);
    const onUnavailable = parseOnUnavailable(e['on_unavailable']);
    const dpop = e['dpop'] === true;
    if (host && audience) out.push({ host: host.toLowerCase(), audience, scopes, enforcement, onUnavailable, dpop });
  }
  return out;
}
