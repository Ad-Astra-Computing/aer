// Hostile-input values for entry points that take untrusted data. A parameter
// typed as an object or a string guarantees nothing once the value crosses
// JSON.parse or a header lookup, so the values get tested rather than trusted.

/** Values a caller can realistically produce where an object is declared. */
export const HOSTILE_OBJECTS: ReadonlyArray<readonly [string, unknown]> = [
  ['null', null],
  ['undefined', undefined],
  ['a number', 12345],
  ['a boolean', true],
  ['a string', 'not an object'],
  ['an array', []],
  ['an empty object', {}],
  // JSON.parse produces this shape; handling it must not reach Object.prototype.
  ['a prototype-pollution payload', JSON.parse('{"__proto__":{"polluted":true}}')],
];

/** Values a caller can realistically produce where a string is declared. */
export const HOSTILE_STRINGS: ReadonlyArray<readonly [string, unknown]> = [
  ['null', null],
  ['undefined', undefined],
  ['a number', 12345],
  ['a boolean', false],
  ['an object', {}],
  ['an array', []],
  ['an empty string', ''],
  ['whitespace only', '   '],
  ['a very long string', 'A'.repeat(100_000)],
];

/**
 * Assert a call answered rather than crashed. TypeError and RangeError are the
 * signatures of an unguarded dereference, so they always fail. An error the
 * package raises on purpose is a valid answer.
 */
export async function answersRatherThanCrashes(
  call: () => unknown,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  try {
    await call();
    return { ok: true };
  } catch (err) {
    if (err instanceof TypeError || err instanceof RangeError) {
      return { ok: false, detail: `${(err as Error).constructor.name}: ${(err as Error).message}` };
    }
    return { ok: true };
  }
}
