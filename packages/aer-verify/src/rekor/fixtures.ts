// Real Rekor public-log fixtures for tests.
//
// These are public transparency-log infrastructure values, not customer data: the
// production rekor.sigstore.dev v1 log public key and one of its signed checkpoints
// (a signed tree head - shared global log state, fetchable by anyone). They lock the
// checkpoint signed-note format and ECDSA-P256 verification against production wire
// bytes so the verifier can never silently drift from what Rekor actually emits.

import { REKOR_SIGSTORE_V1_SPKI_B64, REKOR_SIGSTORE_V1_NAME } from '../trust/rekor-log.js';

/** SPKI DER (base64) of the production rekor.sigstore.dev v1 log key (ECDSA P-256). */
export const REKOR_V1_SPKI_B64 = REKOR_SIGSTORE_V1_SPKI_B64;

/** Signer name that appears on this log's checkpoint signature line. */
export const REKOR_V1_NAME = REKOR_SIGSTORE_V1_NAME;

/** A genuine production checkpoint signed by the key above. */
export const REKOR_V1_CHECKPOINT =
  'rekor.sigstore.dev - 1193050959916656506\n' +
  '1506280580\n' +
  'ZjDd73mjc1W8RZxpRzKqh8APDj+MIHjlQC8Km8UeBpQ=\n' +
  '\n' +
  '— rekor.sigstore.dev wNI9ajBEAiA/pOpue/xfCkoAWy4yASWxiSN7ffSt5+xwHR+Hl8o6EgIgRmu2RQ+rGTisl0L2tETVrIJyf3h0FwfvabDGa3WTPwg=\n';

/** The (treeSize, base64 rootHash) the checkpoint above commits to. */
export const REKOR_V1_CHECKPOINT_TREE_SIZE = 1506280580;
export const REKOR_V1_CHECKPOINT_ROOT_B64 = 'ZjDd73mjc1W8RZxpRzKqh8APDj+MIHjlQC8Km8UeBpQ=';
