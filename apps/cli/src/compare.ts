// `aer compare <aer-a> <aer-b>`: verifies both bundle signatures, then diffs
// their content commitments, execution graph and observations. Fails closed -
// no divergence answer unless both signatures verified - and never needs
// plaintext.

import { compareBundles, builtinTrustRoot, type CompareBundlesResult } from '@adastracomputing/aer-verify';
import { verifyBundleSignature, type BundleSignatureResult } from './verify.js';

export interface ParsedCompareArgs {
  aerA?: string;
  aerB?: string;
  bundlePathA?: string;
  bundlePathB?: string;
}

const KNOWN_FLAGS = new Set(['--bundle-a', '--bundle-b']);

/** Throws on anything it cannot place: an unknown flag, a flag with no value,
 * or more positional ids than the two this command takes. A silently dropped
 * argument (e.g. a typo'd flag, or a third id) would look like the command
 * ran as asked while actually comparing the wrong pair - or comparing
 * nothing the caller intended. */
export function parseCompareArgs(args: string[]): ParsedCompareArgs {
  const out: ParsedCompareArgs = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) continue;
    if (a.startsWith('--')) {
      if (!KNOWN_FLAGS.has(a)) throw new Error(`unknown flag: ${a}`);
      const v = args[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} requires a value`);
      if (a === '--bundle-a') out.bundlePathA = v; else out.bundlePathB = v;
      i++;
    } else {
      positional.push(a);
    }
  }
  const wantPositional = (out.bundlePathA ? 0 : 1) + (out.bundlePathB ? 0 : 1);
  if (positional.length > wantPositional) {
    throw new Error(`too many arguments: ${positional.slice(wantPositional).join(', ')}`);
  }
  const posA = out.bundlePathA ? undefined : positional[0];
  const posB = out.bundlePathB ? undefined : positional[out.bundlePathA ? 0 : 1];
  if (posA !== undefined) out.aerA = posA;
  if (posB !== undefined) out.aerB = posB;
  return out;
}

export interface RunCompareOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  readFile?: (p: string) => Promise<string>;
  trustRoot?: ReturnType<typeof builtinTrustRoot>;
}

export interface CompareResult {
  aer_a: string | null;
  aer_b: string | null;
  bundle_a_verified: boolean;
  bundle_b_verified: boolean;
  comparison: CompareBundlesResult | null;
  bundle_signature_a?: BundleSignatureResult;
  bundle_signature_b?: BundleSignatureResult;
  reason?: 'bundle_signature_unverified';
}

async function loadBundle(
  id: string | undefined,
  bundlePath: string | undefined,
  opts: RunCompareOptions,
  readFile: (p: string) => Promise<string>,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  if (bundlePath) {
    try {
      return JSON.parse(await readFile(bundlePath)) as Record<string, unknown>;
    } catch {
      // Never echo err.message: JSON.parse's SyntaxError embeds a snippet of
      // the unparsable input, which may hold bundle content a caller did not
      // mean to put on stderr.
      throw new Error(`could not read/parse bundle file: ${bundlePath}`);
    }
  }
  if (!id) throw new Error('missing an AER id (or --bundle-a/--bundle-b file).');
  if (!opts.baseUrl) {
    throw new Error('AER_BASE_URL is required to fetch a bundle by id; use --bundle-a/--bundle-b for a fully offline comparison.');
  }
  const base = opts.baseUrl.replace(/\/$/, '');
  const res = await fetchImpl(`${base}/v1/aers/${encodeURIComponent(id)}/bundle`);
  if (!res.ok) throw new Error(`failed to fetch bundle ${id}: ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

/**
 * CLI entry for `aer compare`. Returns { result, exitCode }. exitCode is 0
 * only when both bundles verified AND the comparison found no divergence on
 * every dimension AND every position was actually checked - so it is usable
 * as a CI gate the way `aer verify` is. A bundle that fails to verify, two
 * bundles that are not comparable (different kid, or either has no
 * commitments), a `partial_kid_overlap` (one or both sides rotated their
 * commitment key mid-run, so some positions were never checked), or a
 * comparison where nothing was ever applicable, all always exit 1: the
 * caller must read `reason`/`comparison.reason` rather than assume "passed"
 * means "identical". A whoever-holds-AER_COMMITMENT_KEY rotation mid-session
 * must never make the gate stop checking and still report success.
 */
export async function runCompare(
  args: string[],
  opts: RunCompareOptions,
): Promise<{ result: CompareResult; exitCode: number }> {
  const parsed = parseCompareArgs(args);
  if ((!parsed.aerA && !parsed.bundlePathA) || (!parsed.aerB && !parsed.bundlePathB)) {
    throw new Error('usage: aer compare <aer-id-a> <aer-id-b> | --bundle-a <file.json> --bundle-b <file.json>');
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const readFile = opts.readFile ?? (async (p: string) => (await import('node:fs/promises')).readFile(p, 'utf8'));
  const trustRoot = opts.trustRoot ?? builtinTrustRoot();

  const [bundleA, bundleB] = await Promise.all([
    loadBundle(parsed.aerA, parsed.bundlePathA, opts, readFile, fetchImpl),
    loadBundle(parsed.aerB, parsed.bundlePathB, opts, readFile, fetchImpl),
  ]);

  const [sigA, sigB] = await Promise.all([
    verifyBundleSignature(bundleA, { ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}), fetchImpl, trustRoot }),
    verifyBundleSignature(bundleB, { ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}), fetchImpl, trustRoot }),
  ]);

  const aerA = typeof bundleA['aer_id'] === 'string' ? bundleA['aer_id'] : (parsed.aerA ?? null);
  const aerB = typeof bundleB['aer_id'] === 'string' ? bundleB['aer_id'] : (parsed.aerB ?? null);

  // Fail closed: a tag match against unsigned/tampered evidence proves
  // nothing, so comparison is never run - let alone reported as passing -
  // unless BOTH bundles verified (same posture as `aer commitments verify`).
  if (!sigA.verified || !sigB.verified) {
    return {
      result: {
        aer_a: aerA,
        aer_b: aerB,
        bundle_a_verified: sigA.verified,
        bundle_b_verified: sigB.verified,
        comparison: null,
        bundle_signature_a: sigA,
        bundle_signature_b: sigB,
        reason: 'bundle_signature_unverified',
      },
      exitCode: 1,
    };
  }

  const comparison = compareBundles(bundleA, bundleB);
  // A dimension that was never applicable (e.g. no session captured a wire
  // body) asserted nothing, so it must not block exit 0 the way an actual
  // divergence does - but it also never COUNTS toward "identical", so a
  // comparison with every dimension inapplicable still needs `comparable`
  // and no truncation to pass.
  const noDivergence = [
    comparison.prompts,
    comparison.responses,
    comparison.tool_args,
    comparison.tool_results,
    comparison.wire,
  ].every((dim) => !dim.applicable || dim.identical);
  const identicalOnEveryDimension =
    comparison.comparable &&
    !comparison.reason &&
    noDivergence &&
    // prompt_canon_tag is mandatory on every content commitment (@aer/schemas),
    // so a comparison where it was never applicable checked nothing at all -
    // exit 0 must not be reachable with zero content evidence behind it.
    comparison.prompts.applicable &&
    comparison.actions.identical &&
    comparison.models.identical;

  return {
    result: {
      aer_a: aerA,
      aer_b: aerB,
      bundle_a_verified: true,
      bundle_b_verified: true,
      comparison,
      bundle_signature_a: sigA,
      bundle_signature_b: sigB,
    },
    exitCode: identicalOnEveryDimension ? 0 : 1,
  };
}
