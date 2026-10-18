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

export function parseCompareArgs(args: string[]): ParsedCompareArgs {
  const out: ParsedCompareArgs = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const v = args[i + 1];
    if (a === undefined) continue;
    if (a === '--bundle-a' && v !== undefined) { out.bundlePathA = v; i++; }
    else if (a === '--bundle-b' && v !== undefined) { out.bundlePathB = v; i++; }
    else if (!a.startsWith('--')) positional.push(a);
  }
  const posA = positional[0];
  const posB = positional[out.bundlePathA ? 0 : 1];
  if (!out.bundlePathA && posA !== undefined) out.aerA = posA;
  if (!out.bundlePathB && posB !== undefined) out.aerB = posB;
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
  reason?: string;
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
    } catch (err) {
      throw new Error(`could not read/parse bundle file: ${(err as Error).message}`);
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
 * any dimension that was comparable - so it is usable as a CI gate the way
 * `aer verify` is. A bundle that fails to verify, or two bundles that are not
 * comparable (different kid, or either has no commitments), always exit 1:
 * the caller must read `reason`/`comparison.reason` rather than assume
 * "passed" means "identical".
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
  const identicalOnEveryDimension =
    comparison.comparable &&
    !comparison.reason &&
    comparison.prompts.identical &&
    comparison.responses.identical &&
    comparison.tool_args.identical &&
    comparison.wire.identical &&
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
