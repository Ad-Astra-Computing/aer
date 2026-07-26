import { describe, it, expect } from 'vitest';
import { parseCheckpoint, verifyCheckpoint, keyHintHex, type CheckpointKey } from './checkpoint.js';
import { base64ToBytes } from '../bytes.js';
import {
  REKOR_V1_SPKI_B64,
  REKOR_V1_NAME,
  REKOR_V1_CHECKPOINT,
  REKOR_V1_CHECKPOINT_TREE_SIZE,
  REKOR_V1_CHECKPOINT_ROOT_B64,
} from './fixtures.js';

const rekorKey: CheckpointKey = {
  name: REKOR_V1_NAME,
  spki: base64ToBytes(REKOR_V1_SPKI_B64),
  algorithm: 'ecdsa-p256',
};

describe('Rekor checkpoint parsing', () => {
  it('parses the header lines of a real checkpoint', () => {
    const cp = parseCheckpoint(REKOR_V1_CHECKPOINT);
    expect(cp.origin).toBe('rekor.sigstore.dev - 1193050959916656506');
    expect(cp.treeSize).toBe(REKOR_V1_CHECKPOINT_TREE_SIZE);
    expect(cp.rootHash).toEqual(base64ToBytes(REKOR_V1_CHECKPOINT_ROOT_B64));
    expect(cp.signatures).toHaveLength(1);
    expect(cp.signatures[0]!.name).toBe(REKOR_V1_NAME);
    expect(cp.signatures[0]!.keyHint).toHaveLength(4);
  });

  it('exposes the key hint as the first 4 bytes of SHA-256 over the SPKI', async () => {
    // The production checkpoint's signature line carries hint c0d23d6a.
    expect(await keyHintHex(rekorKey.spki)).toBe('c0d23d6a');
  });

  it('rejects a note with no signature block', () => {
    expect(() => parseCheckpoint('origin\n1\ncm9vdA==\n')).toThrow(/separator/);
  });

  it('rejects a note with too few header lines', () => {
    expect(() => parseCheckpoint('origin\n1\n\n— x AAAAAAA=')).toThrow(/too few/);
  });
});

describe('Rekor checkpoint verification (production wire bytes)', () => {
  it('verifies the real production checkpoint signature', async () => {
    const res = await verifyCheckpoint(REKOR_V1_CHECKPOINT, [rekorKey]);
    expect(res.valid).toBe(true);
    expect(res.signedBy).toBe(REKOR_V1_NAME);
    expect(res.treeSize).toBe(REKOR_V1_CHECKPOINT_TREE_SIZE);
  });

  it('rejects a checkpoint whose body was tampered', async () => {
    // Flip the tree size; the signature no longer covers this body.
    const tampered = REKOR_V1_CHECKPOINT.replace('1506280580', '1506280581');
    const res = await verifyCheckpoint(tampered, [rekorKey]);
    expect(res.valid).toBe(false);
  });

  it('rejects when no pinned key matches the signer name', async () => {
    const res = await verifyCheckpoint(REKOR_V1_CHECKPOINT, [
      { ...rekorKey, name: 'someone.else.dev' },
    ]);
    expect(res.valid).toBe(false);
  });

  it('rejects when the pinned key is the wrong key (hint mismatch)', async () => {
    // A different but structurally valid P-256 SPKI: hint won't match, so we never
    // even reach the crypto check.
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ]);
    const other = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
    const res = await verifyCheckpoint(REKOR_V1_CHECKPOINT, [
      { name: REKOR_V1_NAME, spki: other, algorithm: 'ecdsa-p256' },
    ]);
    expect(res.valid).toBe(false);
  });

  it('returns valid=false (no throw) on a structurally broken note', async () => {
    const res = await verifyCheckpoint('not a checkpoint', [rekorKey]);
    expect(res.valid).toBe(false);
  });
});
