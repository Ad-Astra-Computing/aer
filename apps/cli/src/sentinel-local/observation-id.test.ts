import { describe, it, expect } from 'vitest';
import { computeObservationId } from './observation-id.js';

const KEY = Buffer.from('0'.repeat(64), 'hex');
const TUPLE = { localAddress: '10.0.0.5', localPort: 54321, remoteAddress: '160.79.104.1', remotePort: 443 };

describe('computeObservationId', () => {
  it('is deterministic for the same tuple and tick', () => {
    const a = computeObservationId(KEY, TUPLE, 100);
    const b = computeObservationId(KEY, TUPLE, 100);
    expect(a).toBe(b);
  });

  it('is 64 hex characters', () => {
    const id = computeObservationId(KEY, TUPLE, 100);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs across ticks for the same tuple (retry-stable, not reused indefinitely)', () => {
    const a = computeObservationId(KEY, TUPLE, 100);
    const b = computeObservationId(KEY, TUPLE, 101);
    expect(a).not.toBe(b);
  });

  it('differs across local ports (never collapses distinct connections)', () => {
    const a = computeObservationId(KEY, TUPLE, 100);
    const b = computeObservationId(KEY, { ...TUPLE, localPort: 54322 }, 100);
    expect(a).not.toBe(b);
  });

  it('differs across keys (per-install, not a shared fingerprint)', () => {
    const otherKey = Buffer.from('1'.repeat(64), 'hex');
    const a = computeObservationId(KEY, TUPLE, 100);
    const b = computeObservationId(otherKey, TUPLE, 100);
    expect(a).not.toBe(b);
  });
});
