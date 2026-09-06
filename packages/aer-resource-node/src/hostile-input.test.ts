import { describe, it, expect } from 'vitest';
import { HOSTILE_STRINGS, answersRatherThanCrashes } from '@aer-oss/attestation-test-utils';
import { verifyAttestation } from './index.js';

// The token comes from a request header, so it can be absent or the wrong
// shape no matter what the parameter type declares.
describe('verifyAttestation answers on any hostile token', () => {
  it.each(HOSTILE_STRINGS.map(([label, value]) => [label, value] as const))(
    'denies %s without crashing',
    async (_label, value) => {
      const res = await answersRatherThanCrashes(() =>
        verifyAttestation(value as string, { audience: 'mcp://x' }),
      );
      expect(res).toEqual({ ok: true });
    },
  );
});
