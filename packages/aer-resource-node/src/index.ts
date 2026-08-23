// @adastracomputing/aer-resource-node - verify AER Attestation tokens at a protected
// resource. Offline against cached JWKS, fail-closed. Zero runtime deps; vendors
// EdDSA verify + base64url (no JOSE). Hono/Express middleware are optional
// subpath exports (./hono, ./express).

export const DEFAULT_ISSUER = 'https://aer-api.adastra.computer';
export const DEFAULT_JWKS_URL = 'https://aer-api.adastra.computer/.well-known/aer-attestation-jwks.json';
export const ATTESTATION_TYP = 'aer-attestation+jwt';

export interface AttestationClaims {
  iss: string; aud: string; sub: string;
  tenant_id: string; agent_id: string; agent_session_id: string; environment_id: string;
  iat: number; nbf: number; exp: number; jti: string;
  /** Audience-scoped capabilities (Phase 3). Absent when the token carries none. */
  scp?: string[];
  /**
   * Confirmation (RFC 7800): binds the token to a holder. `jkt` = DPoP key
   * thumbprint (RFC 9449); `x5t#S256` = mTLS client-cert thumbprint (RFC 8705).
   */
  cnf?: { jkt?: string; 'x5t#S256'?: string };
}

/**
 * Replay protection for DPoP proofs (Phase 3 M3). `checkAndRecord` returns true
 * if `jti` was ALREADY recorded (a replay), false if fresh (and records it).
 * `expiresAtMs` bounds retention - a store may drop an entry after that time.
 * The default in-memory store is process-local; multi-instance deployments must
 * supply a SHARED store (e.g. Redis) or replay is only blocked per instance.
 */
export interface ReplayStore {
  checkAndRecord(jti: string, expiresAtMs: number): boolean | Promise<boolean>;
}

export interface Jwk { kty: string; crv: string; use?: string; alg?: string; kid: string; x: string }

export class AttestationError extends Error {
  constructor(public code: string, message?: string) { super(message ?? code); this.name = 'AttestationError'; }
}

/**
 * Optional active-status introspection (ADR-010 2c). When set, after the offline
 * signature/claims check the verifier asks AER whether the token is still active
 * (not revoked, session still running). Positive results are cached briefly so
 * this stays cheap; revocation then takes effect within `activeCacheSec`.
 */
export interface IntrospectOptions {
  url: string;
  /** Verifier key (aerv_…) the resource presents to introspect its own tenant. */
  verifierKey: string;
  /** Cache an `active` result this long (default 10s, hard max 30s, never past exp). */
  activeCacheSec?: number;
  /** Cache an `inactive` result this long (default 5s). */
  inactiveCacheSec?: number;
  /** When introspection is UNREACHABLE (network/5xx/bad body): default fail-closed. */
  onUnavailable?: 'fail-closed' | 'fail-open';
  fetchImpl?: typeof fetch;
}

export interface VerifyOptions {
  audience: string;
  issuer?: string;
  jwksUrl?: string;
  clockToleranceSec?: number;
  fetchImpl?: typeof fetch;
  now?: () => number; // ms
  introspect?: IntrospectOptions;
  /**
   * Capabilities this resource demands (Phase 3). Every entry must appear in the
   * token's `scp`, else AttestationError('insufficient_scope'). Enforced OFFLINE
   * (no introspection needed) - scopes are signed into the token.
   */
  requiredScopes?: string[];
  /**
   * Require a valid DPoP proof bound to the token (Phase 3 M3). When true, the
   * token MUST carry `cnf.jkt` AND the request MUST present a matching DPoP proof
   * (via `dpopProof` + `method` + `url`), else AttestationError. Default off -
   * a bearer token is accepted as before. Opt-in, staged like egress enforcement.
   */
  requireDpop?: boolean;
  /** The DPoP proof JWT from the request's `DPoP` header (when requireDpop). */
  dpopProof?: string | null;
  /** Request method + absolute URL the proof must match (htm/htu). */
  method?: string;
  url?: string;
  /** Replay store for proof jti (default: process-local in-memory, bounded TTL). */
  replayStore?: ReplayStore;
  /** Proof freshness window in seconds (default 120). */
  dpopMaxAgeSec?: number;
  /**
   * Clock skew tolerance for the DPoP proof, in seconds (default 5). Separate
   * from the JWT `clockToleranceSec` (default 30): a proof is fresh, so its window
   * is tight even when the token itself allows looser skew.
   */
  dpopClockToleranceSec?: number;
  /**
   * Require the token to be mTLS-bound (RFC 8705). When true the token MUST carry
   * `cnf["x5t#S256"]` AND the request MUST present a client certificate whose
   * thumbprint (supplied via `mtlsThumbprint`) matches, else AttestationError.
   * Default off - bearer/DPoP behavior is unchanged. Opt-in, like DPoP.
   */
  requireMtls?: boolean;
  /**
   * The presented client certificate's thumbprint - base64url(sha256(cert DER)).
   * Resolve it from the TLS socket (`thumbprintFromPeerCert`) or, behind a TRUSTED
   * terminating proxy, a forwarded header (`thumbprintFromForwardedClientCert`).
   * Null/absent when no client cert was presented.
   */
  mtlsThumbprint?: string | null;
}

/**
 * Verify an attestation token. Returns its claims on success; throws
 * AttestationError on any failure (fail-closed).
 */
export async function verifyAttestation(token: string, opts: VerifyOptions): Promise<AttestationClaims> {
  const issuer = opts.issuer ?? DEFAULT_ISSUER;
  const jwksUrl = opts.jwksUrl ?? DEFAULT_JWKS_URL;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const nowMs = (opts.now ?? Date.now)();
  const nowSec = Math.floor(nowMs / 1000);
  const skew = opts.clockToleranceSec ?? 30;

  const parts = token.split('.');
  if (parts.length !== 3) throw new AttestationError('malformed');
  const [h, p, s] = parts as [string, string, string];

  const header = parseJson<{ alg?: string; typ?: string; kid?: string }>(h);
  if (!header) throw new AttestationError('malformed');
  if (header.alg !== 'EdDSA') throw new AttestationError('bad_alg');
  if (header.typ !== ATTESTATION_TYP) throw new AttestationError('bad_typ');
  if (!header.kid) throw new AttestationError('missing_kid');

  let jwk = await jwksCache.get(jwksUrl, header.kid, fetchImpl, nowMs);
  if (!jwk) throw new AttestationError('unknown_kid');
  // Defense in depth: only ever verify against an OKP/Ed25519 key. The header
  // pins alg=EdDSA; require the JWKS key type to agree so a rotated or
  // mistyped key entry can never be coerced into a different algorithm.
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519') throw new AttestationError('bad_key', 'unexpected_kty');

  // b64urlToBytes throws on non-base64url input; the signature segment is
  // attacker-controlled. Map a decode failure to the typed malformed error so
  // library consumers calling verify directly get AttestationError, never a
  // raw decode throw.
  let pubBytes: Uint8Array;
  let sigBytes: Uint8Array;
  try {
    pubBytes = b64urlToBytes(jwk.x);
    sigBytes = b64urlToBytes(s);
  } catch {
    throw new AttestationError('malformed');
  }
  const ok = await verifyEd25519(pubBytes, new TextEncoder().encode(`${h}.${p}`), sigBytes);
  if (!ok) throw new AttestationError('bad_signature');

  const claims = parseJson<AttestationClaims>(p);
  if (!claims) throw new AttestationError('malformed');
  if (claims.iss !== issuer) throw new AttestationError('bad_issuer');
  if (claims.aud !== opts.audience) throw new AttestationError('bad_audience');
  if (typeof claims.exp !== 'number' || nowSec > claims.exp + skew) throw new AttestationError('expired');
  if (typeof claims.nbf === 'number' && nowSec + skew < claims.nbf) throw new AttestationError('not_yet_valid');
  if (typeof claims.iat !== 'number') throw new AttestationError('missing_iat');

  // Scope enforcement is offline: the scopes are signed into the token, so we
  // gate before the (optional, network) introspection step.
  if (opts.requiredScopes && opts.requiredScopes.length > 0) {
    const have = new Set(Array.isArray(claims.scp) ? claims.scp : []);
    if (!opts.requiredScopes.every((s) => have.has(s))) throw new AttestationError('insufficient_scope');
  }

  // DPoP proof-of-possession (M3): also offline. Binds this request to the
  // holder's key, so a stolen token can't be replayed by another client.
  if (opts.requireDpop) {
    const jkt = claims.cnf?.jkt;
    if (!jkt) throw new AttestationError('dpop_required', 'token_not_bound');
    if (!opts.dpopProof) throw new AttestationError('dpop_required', 'missing_proof');
    if (!opts.method || !opts.url) throw new AttestationError('dpop_misconfigured', 'no_request_context');
    const proof = await verifyDpopProof(opts.dpopProof, {
      method: opts.method, url: opts.url, attestationToken: token, expectedJkt: jkt,
      // A proof is fresh: its window is tight (default 5s) independent of the
      // token's looser clock tolerance.
      nowSec, maxAgeSec: opts.dpopMaxAgeSec ?? 120, skew: opts.dpopClockToleranceSec ?? 5,
    });
    if (!proof.ok) throw new AttestationError('dpop_invalid', proof.reason);
    const store = opts.replayStore ?? defaultReplayStore;
    const expiresAtMs = (typeof claims.exp === 'number' ? claims.exp : nowSec) * 1000;
    // Key replay on jkt:jti so two clients can never collide or poison each other.
    if (await store.checkAndRecord(`${jkt}:${proof.jti}`, expiresAtMs)) throw new AttestationError('dpop_replay');
  }

  // mTLS proof-of-possession (RFC 8705): the token is bound to a client cert; the
  // presented cert's thumbprint must match. Offline, like DPoP. May be required
  // alongside DPoP (both must then pass).
  if (opts.requireMtls) {
    const bound = claims.cnf?.['x5t#S256'];
    if (!bound) throw new AttestationError('mtls_required', 'token_not_bound');
    if (!opts.mtlsThumbprint) throw new AttestationError('mtls_required', 'no_client_cert');
    if (!timingSafeEqualStr(opts.mtlsThumbprint, bound)) throw new AttestationError('mtls_invalid', 'thumbprint_mismatch');
  }

  // Optional active-status introspection (revocation catches the gap that offline
  // verify cannot see). Fail-closed by default on an inactive verdict OR an
  // unreachable introspection service.
  if (opts.introspect) {
    let verdict: { active: boolean; reason?: string };
    try {
      verdict = await introspectionCache.check(token, claims, opts.introspect, nowMs);
    } catch (err) {
      if (opts.introspect.onUnavailable === 'fail-open') return claims; // token already offline-verified + short-lived
      throw err instanceof AttestationError ? err : new AttestationError('introspection_unavailable');
    }
    if (!verdict.active) throw new AttestationError('revoked', verdict.reason ?? 'not_active');
  }

  return claims;
}

/** Read the token from the request header (X-AER-Attestation, or Bearer if allowed). */
export function readAttestationHeader(get: (name: string) => string | null | undefined, allowBearer = false): string | null {
  const x = get('x-aer-attestation');
  if (x) return x.trim();
  if (allowBearer) {
    const a = get('authorization');
    const m = a ? /^Bearer\s+(.+)$/i.exec(a) : null;
    if (m) return m[1]!.trim();
  }
  return null;
}

// ── JWKS cache ────────────────────────────────────────────────────────────────

interface CacheEntry { keys: Jwk[]; expiresAt: number; lastFetch: number }
const MIN_REFETCH_MS = 10_000; // bound refetch-on-unknown-kid

class JwksCache {
  private entries = new Map<string, CacheEntry>();

  /** Reset (tests). */
  reset(): void { this.entries.clear(); }

  async get(url: string, kid: string, fetchImpl: typeof fetch, nowMs: number): Promise<Jwk | null> {
    let entry = this.entries.get(url);
    const fresh = entry && entry.expiresAt > nowMs;
    if (entry && fresh) {
      const found = entry.keys.find((k) => k.kid === kid);
      if (found) return found;
    }
    // Stale, missing, or unknown kid → refetch (rate-limited).
    if (!entry || !fresh || (nowMs - entry.lastFetch >= MIN_REFETCH_MS)) {
      entry = await this.fetch(url, fetchImpl, nowMs).catch(() => entry ?? undefined) as CacheEntry | undefined;
    }
    return entry?.keys.find((k) => k.kid === kid) ?? null;
  }

  private async fetch(url: string, fetchImpl: typeof fetch, nowMs: number): Promise<CacheEntry> {
    const res = await fetchImpl(url);
    if (!res.ok) throw new AttestationError('jwks_fetch_failed', `status ${res.status}`);
    const body = (await res.json()) as { keys?: Jwk[] };
    const keys = Array.isArray(body.keys) ? body.keys : [];
    const maxAge = parseMaxAge(res.headers.get('cache-control')) ?? 300;
    const entry: CacheEntry = { keys, expiresAt: nowMs + maxAge * 1000, lastFetch: nowMs };
    this.entries.set(url, entry);
    return entry;
  }
}

export const jwksCache = new JwksCache();

// ── introspection cache ─────────────────────────────────────────────────────

interface IntrospectionEntry { active: boolean; reason?: string; expiresAt: number }
const INTROSPECT_ACTIVE_DEFAULT_SEC = 10;
const INTROSPECT_ACTIVE_MAX_SEC = 30;
const INTROSPECT_INACTIVE_DEFAULT_SEC = 5;

class IntrospectionCache {
  private entries = new Map<string, IntrospectionEntry>();

  /** Reset (tests). */
  reset(): void { this.entries.clear(); }

  async check(
    token: string,
    claims: AttestationClaims,
    opts: IntrospectOptions,
    nowMs: number,
  ): Promise<{ active: boolean; reason?: string }> {
    const cached = this.entries.get(token);
    if (cached && cached.expiresAt > nowMs) {
      return cached.reason !== undefined ? { active: cached.active, reason: cached.reason } : { active: cached.active };
    }

    const fetchImpl = opts.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await fetchImpl(opts.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${opts.verifierKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      });
    } catch {
      throw new AttestationError('introspection_unavailable');
    }
    if (!res.ok) throw new AttestationError('introspection_unavailable', `status ${res.status}`);
    const body = (await res.json().catch(() => null)) as { active?: boolean; reason?: string } | null;
    if (!body || typeof body.active !== 'boolean') throw new AttestationError('introspection_unavailable', 'bad_response');

    const active = body.active;
    const ttlSec = active
      ? Math.min(opts.activeCacheSec ?? INTROSPECT_ACTIVE_DEFAULT_SEC, INTROSPECT_ACTIVE_MAX_SEC)
      : (opts.inactiveCacheSec ?? INTROSPECT_INACTIVE_DEFAULT_SEC);
    let expiresAt = nowMs + Math.max(0, ttlSec) * 1000;
    // Never cache an active verdict past the token's own expiry.
    if (active && typeof claims.exp === 'number') expiresAt = Math.min(expiresAt, claims.exp * 1000);

    const entry: IntrospectionEntry = { active, expiresAt };
    if (body.reason !== undefined) entry.reason = body.reason;
    this.entries.set(token, entry);
    return body.reason !== undefined ? { active, reason: body.reason } : { active };
  }
}

export const introspectionCache = new IntrospectionCache();

function parseMaxAge(cacheControl: string | null): number | null {
  if (!cacheControl) return null;
  const m = /max-age=(\d+)/.exec(cacheControl);
  return m ? Number(m[1]) : null;
}

// ── DPoP proof verification (RFC 9449, self-contained) ───────────────────────

const DPOP_TYP = 'dpop+jwt';

interface DpopJwk { kty?: string; crv?: string; x?: string }

interface VerifyDpopArgs {
  method: string;
  url: string;
  attestationToken: string;
  expectedJkt: string;
  nowSec: number;
  maxAgeSec: number;
  skew: number;
}

type DpopResult = { ok: true; jti: string } | { ok: false; reason: string };

async function verifyDpopProof(proof: string, args: VerifyDpopArgs): Promise<DpopResult> {
  const parts = proof.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [h, p, s] = parts as [string, string, string];

  const header = parseJson<{ typ?: string; alg?: string; jwk?: DpopJwk }>(h);
  if (!header) return { ok: false, reason: 'malformed' };
  if (header.typ !== DPOP_TYP) return { ok: false, reason: 'bad_typ' };
  if (header.alg !== 'EdDSA') return { ok: false, reason: 'bad_alg' };
  const jwk = header.jwk;
  if (!jwk || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') return { ok: false, reason: 'bad_jwk' };

  let pub: Uint8Array; let sig: Uint8Array;
  try { pub = b64urlToBytes(jwk.x); sig = b64urlToBytes(s); } catch { return { ok: false, reason: 'malformed' }; }
  if (!(await verifyEd25519(pub, new TextEncoder().encode(`${h}.${p}`), sig))) return { ok: false, reason: 'bad_signature' };

  const claims = parseJson<{ htm?: string; htu?: string; iat?: number; jti?: string; ath?: string }>(p);
  if (!claims) return { ok: false, reason: 'malformed' };

  if (!timingSafeEqualStr(await jwkThumbprint(jwk.x), args.expectedJkt)) return { ok: false, reason: 'jkt_mismatch' };
  if (typeof claims.htm !== 'string' || claims.htm.toUpperCase() !== args.method.toUpperCase()) return { ok: false, reason: 'htm_mismatch' };

  let htuOk = false;
  try { htuOk = typeof claims.htu === 'string' && normalizeHtu(claims.htu) === normalizeHtu(args.url); } catch { htuOk = false; }
  if (!htuOk) return { ok: false, reason: 'htu_mismatch' };

  if (typeof claims.iat !== 'number') return { ok: false, reason: 'malformed' };
  if (claims.iat - args.skew > args.nowSec) return { ok: false, reason: 'future_proof' };
  if (args.nowSec - claims.iat > args.maxAgeSec + args.skew) return { ok: false, reason: 'stale_proof' };

  if (typeof claims.ath !== 'string' || !timingSafeEqualStr(claims.ath, await sha256b64url(new TextEncoder().encode(args.attestationToken)))) {
    return { ok: false, reason: 'ath_mismatch' };
  }
  if (typeof claims.jti !== 'string' || !claims.jti) return { ok: false, reason: 'malformed' };
  return { ok: true, jti: claims.jti };
}

/** RFC 7638 thumbprint of an OKP/Ed25519 public key (x is base64url raw key). */
async function jwkThumbprint(x: string): Promise<string> {
  const canonical = `{"crv":"Ed25519","kty":"OKP","x":"${x}"}`;
  return sha256b64url(new TextEncoder().encode(canonical));
}

function normalizeHtu(url: string): string {
  const u = new URL(url);
  const port = u.port ? `:${u.port}` : '';
  return `${u.protocol.toLowerCase()}//${u.hostname.toLowerCase()}${port}${u.pathname}`;
}

/**
 * Constant-time string equality for proof-of-possession bindings (mTLS x5t#S256,
 * DPoP jkt, ath). Compares in time proportional to the input length, not to the
 * position of the first difference, so a network attacker cannot use response
 * timing to recover a target thumbprint/hash byte by byte. Inputs here are
 * fixed-width base64url digests, so the early length check leaks nothing secret.
 */
function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function sha256b64url(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
  let bin = '';
  for (const b of digest) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ── mTLS client-cert thumbprint helpers (RFC 8705 x5t#S256) ──────────────────

/** Minimal shape of a TLS socket carrying a peer certificate (node:tls TLSSocket). */
export interface PeerCertSocket {
  getPeerCertificate?: (detailed?: boolean) => { raw?: Uint8Array } | undefined;
}

/**
 * Compute `x5t#S256` (base64url(sha256(cert DER))) from a TLS socket's peer
 * certificate - for a resource doing DIRECT mTLS (Node `requestCert: true`).
 * Returns null if no client certificate was presented.
 */
export async function thumbprintFromPeerCert(socket: PeerCertSocket | null | undefined): Promise<string | null> {
  const raw = socket?.getPeerCertificate?.()?.raw;
  if (!raw || raw.length === 0) return null;
  return sha256b64url(raw instanceof Uint8Array ? raw : new Uint8Array(raw));
}

export interface ForwardedCertOpts {
  /**
   * `pem` (default): the header value is a (possibly URL-encoded) PEM certificate,
   * e.g. nginx `$ssl_client_escaped_cert`. `xfcc`: an Envoy `X-Forwarded-Client-Cert`
   * value - its `Hash=` (hex sha256) is used directly, else its `Cert="…"` PEM.
   *
   * Security: the header these options parse is only trustworthy when a
   * trusted mTLS-terminating proxy sets it and strips any client-supplied copy.
   * See thumbprintFromForwardedClientCert.
   */
  format?: 'pem' | 'xfcc';
}

/**
 * Compute `x5t#S256` from a forwarded client-cert header.
 *
 * Security: only trust this header when your mTLS-terminating proxy sets it and
 * strips any client-supplied copy first. If a client can set the forwarded-cert
 * header, it can spoof any thumbprint and defeat mTLS binding. For a resource
 * that terminates TLS itself, prefer thumbprintFromPeerCert, which reads the
 * verified peer certificate off the socket and cannot be spoofed by the client.
 */
export async function thumbprintFromForwardedClientCert(
  value: string | null | undefined,
  opts: ForwardedCertOpts = {},
): Promise<string | null> {
  if (!value) return null;
  if ((opts.format ?? 'pem') === 'xfcc') {
    // Hash is a SHA-256 of the leaf cert DER - exactly 64 hex chars. Anything else
    // is malformed; fall through rather than trust a partial value.
    const hash = /(?:^|;|,)\s*Hash=([0-9a-fA-F]{64})(?![0-9a-fA-F])/.exec(value)?.[1];
    if (hash) return hexToB64url(hash);
    const cert = /(?:^|;|,)\s*Cert="([^"]*)"/.exec(value)?.[1];
    return cert ? pemThumbprint(safeDecodeUri(cert)) : null;
  }
  // A PEM chain is NOT parsed as a chain - the leaf (first/whole value) is hashed.
  return pemThumbprint(value.includes('%') ? safeDecodeUri(value) : value);
}

function safeDecodeUri(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

async function pemThumbprint(pem: string): Promise<string | null> {
  const b64 = pem.replace(/-----BEGIN CERTIFICATE-----/g, '').replace(/-----END CERTIFICATE-----/g, '').replace(/\s+/g, '');
  if (!b64) return null;
  try { return await sha256b64url(b64urlToBytesAllowStd(b64)); } catch { return null; }
}

/** Convert a hex digest (Envoy XFCC Hash=) to base64url without re-hashing. */
function hexToB64url(hex: string): string | null {
  if (hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  let bin = '';
  for (const b of out) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decode standard OR url-safe base64 (PEM is standard base64). */
function b64urlToBytesAllowStd(b64: string): Uint8Array {
  const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Default process-local replay store: HARD-bounded. Replay detection always works;
// when the map is full of still-unexpired entries even after GC, it fails CLOSED
// (treats new proofs as replays) so memory can never grow without bound. A
// high-QPS resource should raise the cap or supply a shared store (e.g. Redis).
class MemoryReplayStore implements ReplayStore {
  private seen = new Map<string, number>();
  constructor(private readonly maxEntries = 50_000) {}
  checkAndRecord(key: string, expiresAtMs: number): boolean {
    const now = Date.now();
    const existing = this.seen.get(key);
    if (existing !== undefined && existing > now) return true; // replay within retention window
    if (this.seen.size >= this.maxEntries) {
      for (const [k, exp] of this.seen) if (exp <= now) this.seen.delete(k); // GC expired
      if (this.seen.size >= this.maxEntries) return true; // still full → fail closed (deny)
    }
    this.seen.set(key, expiresAtMs);
    return false;
  }
}

/** Build a process-local in-memory replay store with a hard entry cap (fails closed when full). */
export function createMemoryReplayStore(maxEntries = 50_000): ReplayStore {
  return new MemoryReplayStore(maxEntries);
}

/** The default in-memory replay store (cap 50k, fail-closed when full). */
export const defaultReplayStore = new MemoryReplayStore();

// ── crypto / base64url ────────────────────────────────────────────────────────

async function verifyEd25519(pub: Uint8Array, message: Uint8Array, sig: Uint8Array): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('raw', pub as BufferSource, { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, sig as BufferSource, message as BufferSource);
  } catch {
    return false;
  }
}

function b64urlToBytes(b64url: string): Uint8Array {
  const bin = atob(b64url.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function parseJson<T>(b64url: string): T | null {
  try { return JSON.parse(new TextDecoder().decode(b64urlToBytes(b64url))) as T; } catch { return null; }
}
