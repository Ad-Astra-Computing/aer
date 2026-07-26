// Rekor entry helpers: derive the RFC 6962 leaf hash from a stored entry UUID.
//
// A Rekor v1 entry UUID is the hex of the Merkle leaf hash, optionally prefixed by
// a 16-hex (8-byte) tree-shard id: so 64 hex (unsharded) or 80 hex (sharded). The
// leaf hash is always the trailing 32 bytes — it is what an inclusion proof hashes
// up to the root, so it can be recovered without re-canonicalizing the entry body.

import { hexToBytes } from '../bytes.js';

/**
 * Recover the RFC 6962 leaf hash (32 bytes) from a Rekor entry UUID.
 * Throws if the UUID is not a 64- or 80-hex string.
 */
export function leafHashFromUuid(uuid: string): Uint8Array {
  if (!/^[0-9a-fA-F]+$/.test(uuid) || (uuid.length !== 64 && uuid.length !== 80)) {
    throw new Error(`rekor entry: expected 64- or 80-hex UUID, got length ${uuid.length}`);
  }
  return hexToBytes(uuid.slice(-64));
}

/** The 8-byte tree-shard id from a sharded (80-hex) UUID, or null if unsharded. */
export function treeShardFromUuid(uuid: string): Uint8Array | null {
  if (uuid.length !== 80) return null;
  return hexToBytes(uuid.slice(0, 16));
}
