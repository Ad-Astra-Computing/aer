// UUIDv7 — RFC 9562. Runtime-universal (only globalThis.crypto.getRandomValues).
// Vendored to keep this package dependency-free.

let lastMs = 0;
let lastRandA = 0;

export function newUuidV7(): string {
  const now = Date.now();
  let ms = now;
  let randA: number;

  if (ms === lastMs) {
    randA = (lastRandA + 1) & 0x0fff;
    if (randA === 0) ms = lastMs + 1;
  } else if (ms < lastMs) {
    ms = lastMs;
    randA = (lastRandA + 1) & 0x0fff;
    if (randA === 0) {
      ms = lastMs + 1;
      randA = randBits12();
    }
  } else {
    randA = randBits12();
  }

  lastMs = ms;
  lastRandA = randA;

  const randB = new Uint8Array(8);
  globalThis.crypto.getRandomValues(randB);
  randB[0] = (randB[0]! & 0x3f) | 0x80; // variant 10xxxxxx

  const tsHex = ms.toString(16).padStart(12, '0');
  const randAHex = (0x7000 | randA).toString(16).padStart(4, '0');
  const randBHex = Array.from(randB).map((b) => b.toString(16).padStart(2, '0')).join('');

  return (
    tsHex.slice(0, 8) + '-' +
    tsHex.slice(8, 12) + '-' +
    randAHex + '-' +
    randBHex.slice(0, 4) + '-' +
    randBHex.slice(4, 16)
  );
}

function randBits12(): number {
  const bytes = new Uint8Array(2);
  globalThis.crypto.getRandomValues(bytes);
  return ((bytes[0]! << 8) | bytes[1]!) & 0x0fff;
}
