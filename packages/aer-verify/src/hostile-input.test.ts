import { describe, it, expect } from 'vitest';
import { HOSTILE_OBJECTS, answersRatherThanCrashes } from '@aer-oss/attestation-test-utils';
import { verifyAerBundle } from './verify-aer.js';

// verifyAerBundle takes a bundle straight from JSON.parse or an HTTP body, so
// its declared parameter type guarantees nothing about what arrives.
describe('verifyAerBundle answers on any hostile input', () => {
  it.each(HOSTILE_OBJECTS.map(([label, value]) => [label, value] as const))(
    'returns a verdict for %s',
    async (_label, value) => {
      const res = await answersRatherThanCrashes(() =>
        verifyAerBundle(value as Record<string, unknown>, { publicKeyHex: 'aa' }),
      );
      expect(res).toEqual({ ok: true });
    },
  );

  it('does not pollute Object.prototype', async () => {
    await verifyAerBundle(
      JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>,
      { publicKeyHex: 'aa' },
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
