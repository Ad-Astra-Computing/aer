// Offline verification of AER content commitments (ADR-011).
//
// A content commitment is a customer-key HMAC over the request the collector
// observed. AER holds neither the key nor the plaintext, so only the customer can
// OPEN a commitment: recompute the tag from their retained plaintext under their
// key and check it against the signed bundle. This module is that opener.
//
// STRICT no-plaintext discipline: nothing here logs. The pure verifier returns only
// tags (opaque hex), booleans and the opaque request_ref; the caller's structured
// output never includes the request body or the key. The plaintext lives in memory
// only for the duration of the HMAC.

import {
  canonicalizeRequest,
  promptCanonTag,
  wireBodyTag,
  deriveKid,
  tagsEqual,
  type CanonRequest,
} from '@adastracomputing/aer-auto-node/commitment';
import { verifyBundleSignature, type BundleSignatureResult } from './verify.js';

// One request the customer wants to prove was recorded. `request` is the request
// body they sent to the model (the same object the collector saw: { model,
// messages, system?, tools?, ... }); `provider` selects the canonicalization.
export interface CommitmentCheckInput {
  provider: string;
  request: unknown;
}

export interface CommitmentCheckResult {
  index: number;
  provider: string;
  // Recomputed semantic tag (null when the request could not be canonicalized).
  prompt_canon_tag: string | null;
  // True when the recomputed prompt tag matches a commitment in the VERIFIED
  // bundle. Always false if the bundle signature did not verify (fail closed).
  matched: boolean;
  // The matched commitment's opaque request_ref (null when unmatched or when the
  // tag matched more than one commitment that wire tags could not disambiguate).
  request_ref: string | null;
  // Set when the prompt tag matched multiple commitments and no single one could
  // be pinned by wire tag - the content was committed, but to which request is unclear.
  ambiguous?: boolean;
  // Recomputed wire-body tag, and whether it matched the commitment's wire tag.
  // wire_matched is null when the bundle commitment carried no wire tag.
  wire_canon_tag: string | null;
  wire_matched: boolean | null;
  reason?: string;
}

export interface VerifyCommitmentsResult {
  aer_id: string | null;
  // Whether the bundle's own hash + Ed25519 signature verified. When false, NO
  // commitment is reported as matched - a tag match against unsigned/tampered
  // evidence proves nothing (fail closed).
  bundle_verified: boolean;
  // SHA-256-derived key id of the SUPPLIED key. If this does not equal the
  // commitments' kid, the wrong key was supplied and every tag will mismatch.
  key_kid: string;
  key_kid_matches_bundle: boolean;
  commitments_in_bundle: number;
  checked: number;
  matched: number;
  all_matched: boolean;
  results: CommitmentCheckResult[];
  // The bundle signature check the runner performed (absent from the pure
  // verifier's own return; attached by runCommitmentsVerify).
  bundle_signature?: BundleSignatureResult;
}

interface BundleCommitment {
  request_ref?: unknown;
  kid?: unknown;
  prompt_canon_tag?: unknown;
  wire?: { canon?: unknown; tag?: unknown };
}

interface BundleLike {
  aer_id?: unknown;
  content_commitments?: unknown;
}

const HEX64 = /^[0-9a-f]{64}$/;
const isHex = (x: unknown): x is string => typeof x === 'string' && HEX64.test(x);

/**
 * Pure verifier: recompute each input's tags under `key` and diff against the
 * bundle's content_commitments. No I/O, no logging - safe to unit test and safe
 * for the no-plaintext guarantee (the caller owns all output).
 */
export function verifyCommitments(
  bundle: BundleLike,
  key: Buffer,
  inputs: CommitmentCheckInput[],
  bundleVerified: boolean,
): VerifyCommitmentsResult {
  const commitments: BundleCommitment[] = Array.isArray(bundle.content_commitments)
    ? (bundle.content_commitments.filter((c): c is BundleCommitment => !!c && typeof c === 'object') as BundleCommitment[])
    : [];

  // Index commitments by their prompt tag. A multimap, not a single-value map:
  // distinct requests do not share a tag under a fixed key, but a duplicate tag
  // (e.g. two identical requests) must not silently resolve to one request_ref.
  const byPromptTag = new Map<string, BundleCommitment[]>();
  for (const c of commitments) {
    if (isHex(c.prompt_canon_tag)) {
      const arr = byPromptTag.get(c.prompt_canon_tag);
      if (arr) arr.push(c); else byPromptTag.set(c.prompt_canon_tag, [c]);
    }
  }

  const keyKid = deriveKid(key);
  const keyKidMatchesBundle = commitments.some((c) => c.kid === keyKid);

  const results: CommitmentCheckResult[] = inputs.map((input, index) => {
    let canon: CanonRequest | null = null;
    try {
      canon = canonicalizeRequest(input.provider, [input.request]);
    } catch {
      canon = null;
    }
    if (!canon) {
      return {
        index, provider: input.provider, prompt_canon_tag: null, matched: false,
        request_ref: null, wire_canon_tag: null, wire_matched: null,
        reason: 'could not canonicalize request (unknown provider or malformed body)',
      };
    }
    const promptTag = promptCanonTag(key, canon);
    const wireTag = wireBodyTag(key, input.request);
    // Fail closed: only consult the bundle when its signature verified.
    const candidates = bundleVerified ? (byPromptTag.get(promptTag) ?? []) : [];

    // Resolve which commitment (if any) this request opens.
    let hit: BundleCommitment | undefined;
    let ambiguous = false;
    if (candidates.length === 1) {
      hit = candidates[0];
    } else if (candidates.length > 1) {
      // Disambiguate identical-prompt commitments by wire tag when possible.
      const wireHits = candidates.filter((c) => c.wire && typeof c.wire.tag === 'string' && isHex(c.wire.tag) && tagsEqual(wireTag, c.wire.tag));
      if (wireHits.length === 1) hit = wireHits[0];
      else ambiguous = true; // content committed, but the exact request is unclear
    }

    let wireMatched: boolean | null = null;
    if (hit && hit.wire && typeof hit.wire.tag === 'string') {
      wireMatched = isHex(hit.wire.tag) ? tagsEqual(wireTag, hit.wire.tag) : false;
    }

    const res: CommitmentCheckResult = {
      index,
      provider: input.provider,
      prompt_canon_tag: promptTag,
      // Matched = the tag appears in a signed commitment (fail-closed above).
      matched: candidates.length > 0,
      request_ref: hit && typeof hit.request_ref === 'string' ? hit.request_ref : null,
      wire_canon_tag: wireTag,
      wire_matched: wireMatched,
    };
    if (ambiguous) res.ambiguous = true;
    if (!bundleVerified) res.reason = 'bundle signature did not verify — commitment not trusted';
    return res;
  });

  const matched = results.filter((r) => r.matched).length;
  return {
    aer_id: typeof bundle.aer_id === 'string' ? bundle.aer_id : null,
    bundle_verified: bundleVerified,
    key_kid: keyKid,
    key_kid_matches_bundle: keyKidMatchesBundle,
    commitments_in_bundle: commitments.length,
    checked: inputs.length,
    matched,
    all_matched: bundleVerified && inputs.length > 0 && matched === inputs.length,
    results,
  };
}

// ---- runner ------------------------------------------------------------------

export interface RunCommitmentsVerifyOptions {
  baseUrl: string;
  commitmentKey?: string | undefined; // AER_COMMITMENT_KEY (never logged)
  fetchImpl?: typeof fetch;
  readFile?: (p: string) => Promise<string>;
}

export interface ParsedArgs {
  aerId?: string;
  bundlePath?: string;
  requestsPath?: string;
}

export function parseCommitmentsVerifyArgs(args: string[]): ParsedArgs {
  const out: ParsedArgs = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const v = args[i + 1];
    if (a === '--aer' && v !== undefined) { out.aerId = v; i++; }
    else if (a === '--bundle' && v !== undefined) { out.bundlePath = v; i++; }
    else if (a === '--requests' && v !== undefined) { out.requestsPath = v; i++; }
  }
  return out;
}

function coerceInputs(raw: unknown): CommitmentCheckInput[] {
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.map((r) => {
    const o = (r ?? {}) as Record<string, unknown>;
    return { provider: typeof o['provider'] === 'string' ? o['provider'] : '', request: o['request'] };
  });
}

/**
 * CLI entry for `aer commitments verify`. Returns { result, exitCode }; the caller
 * prints result as JSON. Throws (never partial-prints) on a usage/config error so
 * no half-answer is emitted. Never logs plaintext or the key.
 */
export async function runCommitmentsVerify(
  args: string[],
  opts: RunCommitmentsVerifyOptions,
): Promise<{ result: VerifyCommitmentsResult; exitCode: number }> {
  const { commitmentKeyFromString } = await import('@adastracomputing/aer-auto-node/commitment');
  const key = commitmentKeyFromString(opts.commitmentKey);
  if (!key) {
    throw new Error('AER_COMMITMENT_KEY is required (64 hex chars = 32 bytes) and is never transmitted or logged.');
  }

  const parsed = parseCommitmentsVerifyArgs(args);
  if (!parsed.requestsPath) {
    throw new Error('missing --requests <file.json> (a {provider, request} object or an array of them).');
  }
  if (!parsed.aerId && !parsed.bundlePath) {
    throw new Error('provide the bundle via --aer <aer-id> or --bundle <file.json>.');
  }

  const readFile = opts.readFile ?? (async (p: string) => (await import('node:fs/promises')).readFile(p, 'utf8'));
  const fetchImpl = opts.fetchImpl ?? fetch;

  let requestsRaw: unknown;
  try {
    requestsRaw = JSON.parse(await readFile(parsed.requestsPath));
  } catch (err) {
    throw new Error(`could not read/parse --requests: ${(err as Error).message}`);
  }
  const inputs = coerceInputs(requestsRaw);

  let bundle: BundleLike;
  if (parsed.bundlePath) {
    try {
      bundle = JSON.parse(await readFile(parsed.bundlePath)) as BundleLike;
    } catch (err) {
      throw new Error(`could not read/parse --bundle: ${(err as Error).message}`);
    }
  } else {
    const base = opts.baseUrl.replace(/\/$/, '');
    const res = await fetchImpl(`${base}/v1/aers/${parsed.aerId}/bundle`);
    if (!res.ok) throw new Error(`failed to fetch bundle: ${res.status}`);
    bundle = (await res.json()) as BundleLike;
  }

  // MUST verify the bundle's own hash + Ed25519 signature before trusting any
  // commitment. A tag match against unsigned/tampered JSON proves nothing - only
  // that the plaintext matches a tag someone wrote. The public signing key is
  // fetched from the public /v1/keys endpoint (not a secret). Fail closed.
  const sig = await verifyBundleSignature(bundle as Record<string, unknown>, opts.baseUrl, fetchImpl);

  const result = verifyCommitments(bundle, key, inputs, sig.verified);
  result.bundle_signature = sig;
  // Exit non-zero when the bundle did not verify OR any checked request failed to
  // open, so the command is usable as a scriptable gate.
  return { result, exitCode: result.bundle_verified && result.all_matched ? 0 : 1 };
}
