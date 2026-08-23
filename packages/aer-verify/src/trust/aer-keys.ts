// Pinned AER platform signing keys (production constants, not test fixtures).
//
// These are the public Ed25519 keys the platform signs canonical AER bundles and
// their Rekor DSSE attestations with. Pinning them here is what lets a verifier
// reach `anchored:true` OFFLINE: the anchor's DSSE signature must chain to one of
// THESE keys, never a key fetched from aer.run at verification time (which an
// attacker who controls the origin could swap for one that signed a self-anchored
// forgery in the real public log). Each key is self-authenticating - its
// signing_key_id is the first 16 hex of SHA-256 over the raw 32 key bytes (see
// keys.ts:signingKeyIdFromPublicKey) - so a build-time test asserts the binding and
// a swapped key would fail it immediately.
//
// Key rotation: ADD the new key here (keep retired keys so historical AERs still
// verify) and bump the trust-root version. Never remove a key that signed a
// still-relevant AER. A future owner-signed trust root supersedes this constant.

import type { PinnedKey } from '../result.js';

/** aer.run production AER signing key, active since launch (ed25519). */
export const AER_SIGSTORE_PROD_V1: PinnedKey = {
  signing_key_id: 'a721bb9bd8f31c8e',
  public_key_hex: '39ab92b60e2bdc22a4a30f80f960fa862653247fa501f1e88d181f373d053870',
};

/** All pinned platform AER signing keys (current + historical). */
export function aerSigningKeys(): PinnedKey[] {
  return [AER_SIGSTORE_PROD_V1];
}
