import { randomBytes } from 'node:crypto';
import { z } from 'zod';

const UUID_LOWER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const Uuid = z
  .string()
  .refine((s) => UUID_LOWER.test(s), { message: 'expected lowercase RFC 4122 UUID' });

export type Uuid = z.infer<typeof Uuid>;

let lastMs = 0;
let lastRandA = 0;

/**
 * UUIDv7 per RFC 9562. 48-bit unix-ms timestamp, version nibble = 7,
 * variant bits = 10, monotonic within-ms counter in rand_a.
 */
export function newUuidV7(): string {
  const now = Date.now();
  let ms = now;
  let randA: number;

  if (ms === lastMs) {
    randA = (lastRandA + 1) & 0x0fff;
    if (randA === 0) {
      ms = lastMs + 1;
    }
  } else if (ms < lastMs) {
    ms = lastMs;
    randA = (lastRandA + 1) & 0x0fff;
    if (randA === 0) {
      ms = lastMs + 1;
      randA = randBits(12);
    }
  } else {
    randA = randBits(12);
  }

  lastMs = ms;
  lastRandA = randA;

  const randB = randomBytes(8);
  randB[0] = (randB[0]! & 0x3f) | 0x80;

  const tsHex = ms.toString(16).padStart(12, '0');
  const randAHex = (0x7000 | randA).toString(16).padStart(4, '0');
  const randBHex = randB.toString('hex');

  return (
    tsHex.slice(0, 8) +
    '-' +
    tsHex.slice(8, 12) +
    '-' +
    randAHex +
    '-' +
    randBHex.slice(0, 4) +
    '-' +
    randBHex.slice(4, 16)
  );
}

export function isUuidV7(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (!UUID_LOWER.test(value)) return false;
  return value.charAt(14) === '7';
}

function randBits(bits: number): number {
  const bytes = randomBytes(2);
  const n = (bytes[0]! << 8) | bytes[1]!;
  return n & ((1 << bits) - 1);
}
