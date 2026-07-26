// Pinned Rekor transparency-log keys (production constants, not test fixtures).
//
// These are the public log keys an AER verifier trusts to have signed the tree
// heads (checkpoints) that anchor AERs. Pinning them here is what makes anchor
// verification origin-independent: a verifier confirms an inclusion proof against
// a checkpoint signed by ONE of these keys, without contacting aer.run or a live
// Rekor read API (which the v2 tiles migration will reshape anyway).

import { base64ToBytes } from '../bytes.js';
import type { CheckpointKey } from '../rekor/checkpoint.js';

/** SPKI DER (base64) of the production rekor.sigstore.dev v1 log key (ECDSA P-256). */
export const REKOR_SIGSTORE_V1_SPKI_B64 =
  'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE2G2Y+2tabdTV5BcGiBIx0a9fAFwr' +
  'kBbmLSGtks4L3qX6yYY0zufBnhC8Ur/iy55GhWP/9A/bY2LhC30M9+RYtw==';

/** Signer name on this log's checkpoint signature lines. */
export const REKOR_SIGSTORE_V1_NAME = 'rekor.sigstore.dev';

/** The Rekor v1 log as a pinned checkpoint-verification key. */
export function rekorSigstoreV1(): CheckpointKey {
  return {
    name: REKOR_SIGSTORE_V1_NAME,
    spki: base64ToBytes(REKOR_SIGSTORE_V1_SPKI_B64),
    algorithm: 'ecdsa-p256',
  };
}
