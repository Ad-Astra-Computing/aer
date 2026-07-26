import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  CANON_VERSION,
  deriveKid,
  commitmentKeyFromString,
  canonicalizeRequest,
  promptCanonTag,
  responseTag,
  wireBodyTag,
  toolArgsTag,
  toolResultTag,
  tagsEqual,
} from './commitment.js';

// A 32-byte test key expressed as 64 hex chars.
const KEY_HEX = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const KEY = commitmentKeyFromString(KEY_HEX)!;
const KEY2 = commitmentKeyFromString('ff'.repeat(32))!;

// The SAME logical prompt expressed in OpenAI vs Anthropic request shapes.
const openaiArgs = [
  {
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hi there.' },
    ],
    tools: [
      { type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: { q: { type: 'string' } } } } },
    ],
  },
];
const anthropicArgs = [
  {
    model: 'claude-opus-4-8',
    system: 'You are helpful.',
    messages: [{ role: 'user', content: 'Hi there.' }],
    tools: [
      { name: 'lookup', input_schema: { type: 'object', properties: { q: { type: 'string' } } } },
    ],
  },
];

describe('commitmentKeyFromString', () => {
  it('accepts a 64-hex (32-byte) key', () => {
    expect(commitmentKeyFromString(KEY_HEX)).toBeInstanceOf(Buffer);
    expect(commitmentKeyFromString(KEY_HEX)!.length).toBe(32);
  });
  it('accepts base64 of >=32 bytes', () => {
    const b64 = Buffer.alloc(32, 7).toString('base64');
    expect(commitmentKeyFromString(b64)!.length).toBeGreaterThanOrEqual(32);
  });
  it('accepts a base64url key of >=32 bytes', () => {
    const b64url = Buffer.alloc(32, 7).toString('base64url');
    expect(commitmentKeyFromString(b64url)!.length).toBe(32);
  });
  it('rejects a too-short key (feature stays off)', () => {
    expect(commitmentKeyFromString('abc')).toBeNull();
    expect(commitmentKeyFromString('00'.repeat(16))).toBeNull(); // 16 bytes
    expect(commitmentKeyFromString('')).toBeNull();
    expect(commitmentKeyFromString(undefined)).toBeNull();
  });
  it('rejects a non-strict base64 string rather than silently partial-decoding it', () => {
    // Node's decoder would drop the spaces and '@' and yield an unintended key.
    const garbage = Buffer.alloc(32, 7).toString('base64').replace(/.$/, ' @ ');
    expect(commitmentKeyFromString(garbage)).toBeNull();
  });
});

describe('tagsEqual', () => {
  const A = 'a'.repeat(64);
  const B = 'b'.repeat(64);
  it('is true only for two identical 64-hex tags', () => {
    expect(tagsEqual(A, A)).toBe(true);
    expect(tagsEqual(A, B)).toBe(false);
    expect(tagsEqual(A, A.toUpperCase())).toBe(true); // hex is case-insensitive
  });
  it('rejects anything that is not exactly 64 hex chars (no truncated compare)', () => {
    expect(tagsEqual(A.slice(0, 63), A.slice(0, 63))).toBe(false); // 63 chars
    expect(tagsEqual(A + 'a', A + 'a')).toBe(false); // 65 chars
    expect(tagsEqual('z'.repeat(64), 'z'.repeat(64))).toBe(false); // non-hex
    expect(tagsEqual('', '')).toBe(false);
  });
});

describe('deriveKid', () => {
  it('is deterministic and 16 hex chars', () => {
    const kid = deriveKid(KEY);
    expect(kid).toMatch(/^[0-9a-f]{16}$/);
    expect(deriveKid(KEY)).toBe(kid);
  });
  it('is domain-separated from a bare SHA-256 of the key', () => {
    const bare = createHash('sha256').update(KEY).digest('hex').slice(0, 16);
    expect(deriveKid(KEY)).not.toBe(bare);
  });
  it('differs per key', () => {
    expect(deriveKid(KEY)).not.toBe(deriveKid(KEY2));
  });
});

describe('canonicalizeRequest — cross-provider equivalence (the headline vector)', () => {
  it('OpenAI and Anthropic shapes of the same logical prompt produce the SAME prompt_canon_tag', () => {
    const oa = canonicalizeRequest('openai', openaiArgs)!;
    const an = canonicalizeRequest('anthropic', anthropicArgs)!;
    expect(oa).not.toBeNull();
    expect(an).not.toBeNull();
    expect(promptCanonTag(KEY, oa)).toBe(promptCanonTag(KEY, an));
  });
  it('returns null for an unrecognized / empty request', () => {
    expect(canonicalizeRequest('openai', [])).toBeNull();
    expect(canonicalizeRequest('openai', [{}])).toBeNull();
    expect(canonicalizeRequest('mystery', [{ model: 'x', messages: [] }])).toBeNull();
  });
  it('reports message_count and the canon version', () => {
    const oa = canonicalizeRequest('openai', openaiArgs)!;
    expect(oa.version).toBe(CANON_VERSION);
    expect(oa.message_count).toBe(1); // system is hoisted, not counted as a message
  });
});

describe('canonicalizeRequest — normalization invariants', () => {
  const base = { model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi there.' }] };
  const tagFor = (a: unknown[]) => promptCanonTag(KEY, canonicalizeRequest('openai', a)!);

  it('system null / "" / absent all normalize to the same tag', () => {
    const absent = tagFor([base]);
    const nullSys = tagFor([{ ...base, messages: [{ role: 'system', content: '' }, ...base.messages] }]);
    // An empty system is equivalent to no system.
    expect(nullSys).toBe(absent);
  });

  it('content as a string equals content as a single text block', () => {
    const asString = tagFor([base]);
    const asBlock = tagFor([{ model: 'gpt-4o', messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi there.' }] }] }]);
    expect(asBlock).toBe(asString);
  });

  it('preserves message ORDER (swapping two messages changes the tag)', () => {
    const a = tagFor([{ model: 'gpt-4o', messages: [{ role: 'user', content: 'one' }, { role: 'user', content: 'two' }] }]);
    const b = tagFor([{ model: 'gpt-4o', messages: [{ role: 'user', content: 'two' }, { role: 'user', content: 'one' }] }]);
    expect(a).not.toBe(b);
  });

  it('preserves tool ORDER (swapping two tools changes the tag)', () => {
    const t1 = { type: 'function', function: { name: 'a', parameters: {} } };
    const t2 = { type: 'function', function: { name: 'b', parameters: {} } };
    const a = tagFor([{ ...base, tools: [t1, t2] }]);
    const b = tagFor([{ ...base, tools: [t2, t1] }]);
    expect(a).not.toBe(b);
  });

  it('ignores provider-assigned message ids (only role + text are in the hash domain)', () => {
    const plain = tagFor([base]);
    const withId = tagFor([{ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi there.', tool_call_id: 'call_abc123', id: 'msg_x' }] }]);
    expect(withId).toBe(plain);
  });

  it('normalizes Unicode to NFC (same logical string, different form → same tag)', () => {
    const nfc = tagFor([{ model: 'gpt-4o', messages: [{ role: 'user', content: 'caf\u00e9' }] }]); // precomposed
    const nfd = tagFor([{ model: 'gpt-4o', messages: [{ role: 'user', content: 'cafe\u0301' }] }]); // decomposed
    expect(nfd).toBe(nfc);
  });

  it('canonicalizes numbers in tool schemas (1e6 equals 1000000)', () => {
    const a = tagFor([{ ...base, tools: [{ type: 'function', function: { name: 't', parameters: { maxLength: 1e6 } } }] }]);
    const b = tagFor([{ ...base, tools: [{ type: 'function', function: { name: 't', parameters: { maxLength: 1000000 } } }] }]);
    expect(a).toBe(b);
  });

  it('sorts object keys deeply (schema key order does not matter)', () => {
    const a = tagFor([{ ...base, tools: [{ type: 'function', function: { name: 't', parameters: { a: 1, b: 2 } } }] }]);
    const b = tagFor([{ ...base, tools: [{ type: 'function', function: { name: 't', parameters: { b: 2, a: 1 } } }] }]);
    expect(a).toBe(b);
  });

  it('encodes object keys distinctly and never folds a key out of the preimage', () => {
    // The value under a key still drives the tag: same key, different value differ.
    const a = tagFor([{ ...base, tools: [{ type: 'function', function: { name: 't', parameters: { ['cafe\u0301']: 1 } } }] }]); // NFD key
    const b = tagFor([{ ...base, tools: [{ type: 'function', function: { name: 't', parameters: { ['cafe\u0301']: 2 } } }] }]); // NFD key
    expect(a).not.toBe(b);
    // Keys are NOT NFC-folded: a precomposed and a decomposed key are distinct
    // properties and must not share a tag, or a key could be forged out of the body.
    const c = tagFor([{ ...base, tools: [{ type: 'function', function: { name: 't', parameters: { ['caf\u00e9']: 1 } } }] }]); // NFC key
    expect(c).not.toBe(a);
  });

  it('has no NFC key-collapse collision: an added colliding key changes the tag', () => {
    // Regression vector: folding NFC-colliding keys with last-wins made
    // { "\u00e9": 2 } and { "e\u0301": 1, "\u00e9": 2 } canonically identical, dropping a key.
    // Encoding original keys distinctly keeps them different.
    const one = tagFor([{ ...base, tools: [{ type: 'function', function: { name: 't', parameters: { ['\u00e9']: 2 } } }] }]);
    const two = tagFor([{ ...base, tools: [{ type: 'function', function: { name: 't', parameters: { ['e\u0301']: 1, ['\u00e9']: 2 } } }] }]);
    expect(one).not.toBe(two);
  });

  it('preserves system block boundaries (["a","b"] does not collapse to "ab")', () => {
    const two = tagFor([{ model: 'gpt-4o', messages: [
      { role: 'system', content: 'a' }, { role: 'system', content: 'b' }, { role: 'user', content: 'hi' },
    ] }]);
    const one = tagFor([{ model: 'gpt-4o', messages: [
      { role: 'system', content: 'ab' }, { role: 'user', content: 'hi' },
    ] }]);
    expect(two).not.toBe(one);
  });

  it('preserves multipart content boundaries (["a","b"] does not collapse to "ab")', () => {
    const two = tagFor([{ model: 'gpt-4o', messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }] }]);
    const one = tagFor([{ model: 'gpt-4o', messages: [{ role: 'user', content: 'ab' }] }]);
    expect(two).not.toBe(one);
  });
});

describe('promptCanonTag — keyed (no brute-force oracle)', () => {
  it('is deterministic for a given key', () => {
    const c = canonicalizeRequest('openai', openaiArgs)!;
    expect(promptCanonTag(KEY, c)).toBe(promptCanonTag(KEY, c));
  });
  it('differs under a different key (so a holder of the tag without the key cannot confirm content)', () => {
    const c = canonicalizeRequest('openai', openaiArgs)!;
    expect(promptCanonTag(KEY, c)).not.toBe(promptCanonTag(KEY2, c));
  });
  it('is a 64-hex HMAC-SHA256 tag', () => {
    const c = canonicalizeRequest('openai', openaiArgs)!;
    expect(promptCanonTag(KEY, c)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('responseTag', () => {
  it('commits assembled text and is deterministic', () => {
    expect(responseTag(KEY, 'hello world')).toBe(responseTag(KEY, 'hello world'));
    expect(responseTag(KEY, 'hello world')).toMatch(/^[0-9a-f]{64}$/);
  });
  it('has a defined tag for empty output (partial/aborted stays unambiguous)', () => {
    expect(responseTag(KEY, '')).toMatch(/^[0-9a-f]{64}$/);
    expect(responseTag(KEY, '')).not.toBe(responseTag(KEY, 'x'));
  });
  it('normalizes NFC and differs per key', () => {
    expect(responseTag(KEY, 'caf\u00e9')).toBe(responseTag(KEY, 'cafe\u0301'));
    expect(responseTag(KEY, 'caf\u00e9')).not.toBe(responseTag(KEY2, 'caf\u00e9'));
  });
  it('streaming assembly equals the non-streaming tag for the same final text', () => {
    // A response streamed as deltas ["hel","lo"] committed as the assembled
    // "hello" must equal the non-streaming tag over "hello".
    const assembled = ['hel', 'lo'].join('');
    expect(responseTag(KEY, assembled)).toBe(responseTag(KEY, 'hello'));
  });
});

describe('wireBodyTag (capture_point: wire, slice 2)', () => {
  const body = { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], temperature: 0.7 };
  it('is a deterministic 64-hex tag, key-order independent', () => {
    expect(wireBodyTag(KEY, body)).toMatch(/^[0-9a-f]{64}$/);
    const reordered = { messages: [{ role: 'user', content: 'hi' }], temperature: 0.7, model: 'gpt-4o' };
    expect(wireBodyTag(KEY, body)).toBe(wireBodyTag(KEY, reordered));
  });
  it('commits sampling params the SEMANTIC tag deliberately strips', () => {
    // prompt_canon_tag ignores temperature; the wire tag must not.
    const hot = { ...body, temperature: 0.9 };
    expect(wireBodyTag(KEY, body)).not.toBe(wireBodyTag(KEY, hot));
    const cSame = canonicalizeRequest('openai', [body])!;
    const cHot = canonicalizeRequest('openai', [hot])!;
    expect(promptCanonTag(KEY, cSame)).toBe(promptCanonTag(KEY, cHot)); // semantic tag identical
  });
  it('differs per key (no oracle)', () => {
    expect(wireBodyTag(KEY, body)).not.toBe(wireBodyTag(KEY2, body));
  });
  it('depth-ceiling sentinel does NOT collide with the literal string form', () => {
    // A value nested past the depth ceiling is committed as the bare token
    // __aer_max_depth__; the literal string "__aer_max_depth__" is committed
    // quoted. At the same field these must produce different tags — a quoted
    // sentinel would have let the two share a tag (the pre-publish canon fix).
    let deep: unknown = 1;
    for (let i = 0; i < 70; i++) deep = { a: deep };
    const bodyDeep = { x: deep };
    const bodyLiteral = { x: '__aer_max_depth__' };
    expect(wireBodyTag(KEY, bodyDeep)).not.toBe(wireBodyTag(KEY, bodyLiteral));
  });
});

describe('toolArgsTag (slice 2) \u2014 cross-provider equivalence', () => {
  it('OpenAI JSON-string args and Anthropic object input yield the SAME tag', () => {
    const openaiArgsStr = '{"q":"weather","limit":5}';
    const anthropicInput = { q: 'weather', limit: 5 };
    expect(toolArgsTag(KEY, 'search', openaiArgsStr)).toBe(toolArgsTag(KEY, 'search', anthropicInput));
  });
  it('is key-order independent inside the args object', () => {
    expect(toolArgsTag(KEY, 'search', { a: 1, b: 2 })).toBe(toolArgsTag(KEY, 'search', { b: 2, a: 1 }));
  });
  it('binds the tool name (same args, different tool \u2192 different tag)', () => {
    expect(toolArgsTag(KEY, 'search', { q: 'x' })).not.toBe(toolArgsTag(KEY, 'lookup', { q: 'x' }));
  });
  it('is a 64-hex tag that differs per key', () => {
    expect(toolArgsTag(KEY, 'search', { q: 'x' })).toMatch(/^[0-9a-f]{64}$/);
    expect(toolArgsTag(KEY, 'search', { q: 'x' })).not.toBe(toolArgsTag(KEY2, 'search', { q: 'x' }));
  });
  it('does not collide with a wire or response tag over the same value (domain separation)', () => {
    expect(toolArgsTag(KEY, 'x', { a: 1 })).not.toBe(wireBodyTag(KEY, { name: 'x', args: { a: 1 } }));
  });
});

describe('toolResultTag (slice 2)', () => {
  it('JSON-string and object results of the same data match', () => {
    expect(toolResultTag(KEY, '{"temp":72,"unit":"F"}')).toBe(toolResultTag(KEY, { temp: 72, unit: 'F' }));
  });
  it('is a 64-hex tag, deterministic, differs per key and per content', () => {
    expect(toolResultTag(KEY, { temp: 72 })).toMatch(/^[0-9a-f]{64}$/);
    expect(toolResultTag(KEY, { temp: 72 })).toBe(toolResultTag(KEY, { temp: 72 }));
    expect(toolResultTag(KEY, { temp: 72 })).not.toBe(toolResultTag(KEY, { temp: 73 }));
    expect(toolResultTag(KEY, { temp: 72 })).not.toBe(toolResultTag(KEY2, { temp: 72 }));
  });
  it('is domain-separated from tool args (same value \u2192 different tag)', () => {
    expect(toolResultTag(KEY, { a: 1 })).not.toBe(toolArgsTag(KEY, '', { a: 1 }));
  });
});

describe('slice 2 hardening \u2014 bounded against adversarial JSON', () => {
  it('an oversized JSON-string arg is hashed as a string (not parsed), returns a tag fast', () => {
    const huge = '[' + '0,'.repeat(200_000) + '0]'; // ~600 KB, over the parse cap
    const t0 = Date.now();
    const tag = toolArgsTag(KEY, 'x', huge);
    expect(tag).toMatch(/^[0-9a-f]{64}$/);
    expect(Date.now() - t0).toBeLessThan(1000);
    // Because it's hashed as a raw string (not parsed), a semantically-equal small
    // object does NOT match \u2014 the cap changed the domain, which is fine + safe.
    expect(tag).toBe(toolArgsTag(KEY, 'x', huge));
  });

  it('a deeply-nested value canonicalizes without a stack overflow', () => {
    let deep: unknown = 1;
    for (let i = 0; i < 5000; i++) deep = { n: deep };
    expect(() => toolArgsTag(KEY, 'x', deep)).not.toThrow();
    expect(toolArgsTag(KEY, 'x', deep)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a deeply-nested JSON STRING arg is not parsed past the cap and does not throw', () => {
    const openNest = '{"n":'.repeat(100_000);
    const deepJson = openNest + '1' + '}'.repeat(100_000); // valid but pathologically deep + large
    expect(() => toolArgsTag(KEY, 'x', deepJson)).not.toThrow();
    expect(toolArgsTag(KEY, 'x', deepJson)).toMatch(/^[0-9a-f]{64}$/);
  });
});
