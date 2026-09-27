/**
 * @adastracomputing/aer-verify, exercised from the installed package.
 *
 * Every scenario runs in a fresh Node process. The script mints its own
 * Ed25519 AER key and its own P-256 "transparency log" key, so the full
 * offline anchor chain (inclusion proof, signed checkpoint, Rekor body, DSSE
 * envelope, attestation) can be built and verified with no network and no
 * real key. The verifier trusts whatever log key the caller pins, which is
 * what makes a self-minted log a faithful test of the chain.
 */

const PKG = '@adastracomputing/aer-verify';

// Runs in the child. Builds the fixtures, runs one scenario, prints JSON.
const SCRIPT = String.raw`
import * as V from '@adastracomputing/aer-verify';
import { generateKeyPairSync, sign, createHash, randomUUID, randomBytes } from 'node:crypto';

const scenario = process.env.MX_SCENARIO;
const sha = (b) => createHash('sha256').update(b).digest();
const hex = (b) => Buffer.from(b).toString('hex');
const b64 = (b) => Buffer.from(b).toString('base64');

// An independent canonicalizer: sorted keys at every depth, arrays in order.
// Only used to cross-check the package on this fixture, never to verify.
const canon = (v) => Array.isArray(v) ? '[' + v.map(canon).join(',') + ']'
  : v && typeof v === 'object' ? '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}'
  : JSON.stringify(v);

function mintAerKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  return { privateKey, rawHex: hex(raw), kid: hex(sha(raw)).slice(0, 16) };
}

function makeBundle(key, extra = {}) {
  const body = {
    schema_version: 'aer.v1',
    aer_id: randomUUID(),
    tenant_id: randomUUID(),
    session: { agent_session_id: randomUUID(), status: 'completed', started_at: '2026-01-01T00:00:00.000Z' },
    trace: { tools: [{ name: 'Bash', count: 2 }], hosts: ['example.com'], nested: { z: 1, a: [3, 2, 1], m: null } },
    unicode: 'naive café ☃',
    ...extra,
  };
  const hash = hex(sha(Buffer.from(canon(body), 'utf8')));
  const signature = b64(sign(null, Buffer.from(hash, 'hex'), key.privateKey));
  return { ...body, integrity: { hash, signature, signing_key_id: key.kid } };
}

// A one-off P-256 log and a two-leaf tree whose left leaf is the AER entry.
function makeAnchor(key, bundle, { signedAt = '2026-01-01T00:00:01.000Z' } = {}) {
  const log = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const spki = log.publicKey.export({ format: 'der', type: 'spki' });
  const payloadObj = {
    _type: V.ATTESTATION_SCHEMA,
    aer_id: bundle.aer_id,
    canonical_hash: bundle.integrity.hash,
    signing_key_id: key.kid,
    signed_at: signedAt,
  };
  const payload = Buffer.from(JSON.stringify(payloadObj));
  const pae = Buffer.concat([
    Buffer.from('DSSEv1 ' + Buffer.byteLength(V.ATTESTATION_TYPE) + ' ' + V.ATTESTATION_TYPE + ' ' + payload.length + ' '),
    payload,
  ]);
  const dsseSig = b64(sign(null, pae, key.privateKey));
  const envelope = { payloadType: V.ATTESTATION_TYPE, payload: b64(payload), signatures: [{ sig: dsseSig, keyid: key.kid }] };
  const body = Buffer.from(JSON.stringify({
    apiVersion: '0.0.1',
    kind: 'dsse',
    spec: {
      envelopeHash: { algorithm: 'sha256', value: hex(sha(Buffer.from(JSON.stringify(envelope)))) },
      payloadHash: { algorithm: 'sha256', value: hex(sha(payload)) },
      signatures: [{ signature: dsseSig, verifier: b64('matrix-verifier') }],
    },
  }));
  const leaf0 = sha(Buffer.concat([Buffer.from([0]), body]));
  const leaf1 = sha(Buffer.concat([Buffer.from([0]), randomBytes(64)]));
  const root = sha(Buffer.concat([Buffer.from([1]), leaf0, leaf1]));
  const text = 'matrix.log - 42\n2\n' + b64(root) + '\n';
  const cpSig = sign('sha256', Buffer.from(text), { key: log.privateKey, dsaEncoding: 'der' });
  const hint = sha(spki).subarray(0, 4);
  const checkpoint = text + '\n' + '\u2014 matrix.log ' + b64(Buffer.concat([hint, cpSig])) + '\n';
  const evidence = {
    uuid: hex(leaf0),
    logIndex: 7,
    integratedTime: 1767225601,
    verification: { inclusionProof: { logIndex: 0, treeSize: 2, rootHash: hex(root), hashes: [hex(leaf1)], checkpoint } },
    body: b64(body),
    envelope,
  };
  const rekorLogs = [{ name: 'matrix.log', spki: new Uint8Array(spki), algorithm: 'ecdsa-p256' }];
  return { evidence, rekorLogs };
}

const key = mintAerKey();
const other = mintAerKey();
const bundle = makeBundle(key);
const pinned = [{ signing_key_id: key.kid, public_key_hex: key.rawHex, status: 'active' }];
const clone = (o) => JSON.parse(JSON.stringify(o));

async function attempt(fn) {
  try { return { threw: false, value: await fn() }; }
  catch (e) { return { threw: true, error: (e && e.constructor && e.constructor.name) + ': ' + (e && e.message) }; }
}
const verdict = (r) => r && typeof r === 'object'
  ? { ok: r.ok, reasons: r.reasons, anchor: r.checks && r.checks.anchor, anchored: r.anchored, checks: r.checks, canonical_hash: r.canonical_hash }
  : r;

const S = {
  async canonical_parity() {
    const { integrity, ...rest } = bundle;
    return { pkg: V.canonicalize(rest) === canon(rest), hash: (await V.canonicalHash(rest)) === integrity.hash };
  },
  good_fallback_key: () => V.verifyAerBundle(bundle, { publicKeyHex: key.rawHex }),
  good_pinned: () => V.verifyAerBundle(bundle, { pinnedKeys: pinned }),
  wrong_pinned: () => V.verifyAerBundle(bundle, { pinnedKeys: [{ signing_key_id: other.kid, public_key_hex: other.rawHex }] }),
  wrong_key: () => V.verifyAerBundle(bundle, { publicKeyHex: other.rawHex }),
  no_key: () => V.verifyAerBundle(bundle, {}),
  tampered_field: () => { const b = clone(bundle); b.trace.hosts.push('evil.example'); return V.verifyAerBundle(b, { pinnedKeys: pinned }); },
  tampered_rehashed: () => {
    // An attacker edits the body and recomputes the hash but cannot re-sign.
    const b = clone(bundle); b.session.status = 'aborted';
    const { integrity, ...rest } = b; b.integrity.hash = hex(sha(Buffer.from(canon(rest))));
    return V.verifyAerBundle(b, { pinnedKeys: pinned });
  },
  tampered_signature: () => { const b = clone(bundle); b.integrity.signature = b64(randomBytes(64)); return V.verifyAerBundle(b, { pinnedKeys: pinned }); },
  swapped_key_id: () => { const b = clone(bundle); b.integrity.signing_key_id = other.kid; return V.verifyAerBundle(b, { publicKeyHex: key.rawHex }); },
  async hostile_bundles() {
    let deep = {}; const top = deep; for (let i = 0; i < 5000; i++) { deep.x = {}; deep = deep.x; }
    const inputs = {
      null: null, undefined: undefined, array: [], string: 'not a bundle', number: 42, boolean: true, empty: {},
      proto: JSON.parse('{"__proto__":{"polluted":true},"integrity":{"hash":"00","signature":"AA==","signing_key_id":"x"}}'),
      integrity_null: { integrity: null }, integrity_array: { integrity: [] },
      integrity_numbers: { integrity: { hash: 1, signature: 2, signing_key_id: 3 } },
      bad_hex_hash: { ...clone(bundle), integrity: { ...bundle.integrity, hash: 'zz' } },
      bad_b64_sig: { ...clone(bundle), integrity: { ...bundle.integrity, signature: '%%%not base64%%%' } },
      deep: { ...top, integrity: bundle.integrity },
      nan: { ...clone(bundle), n: NaN }, bigint: { ...clone(bundle), n: 10n }, date: { ...clone(bundle), n: new Date(0) },
      fn: { ...clone(bundle), n: () => 1 }, sym: { ...clone(bundle), n: Symbol('s') },
    };
    const out = {};
    for (const [k, v] of Object.entries(inputs)) {
      const r = await attempt(() => V.verifyAerBundle(v, { pinnedKeys: pinned }));
      out[k] = r.threw ? { threw: r.error } : { ok: r.value.ok, reasons: r.value.reasons };
    }
    return out;
  },
  async hostile_keys() {
    const inputs = {
      pk_not_hex: { publicKeyHex: 'zz'.repeat(32) }, pk_short: { publicKeyHex: 'abcd' }, pk_empty: { publicKeyHex: '' },
      pk_number: { publicKeyHex: 12345 }, pk_object: { publicKeyHex: {} }, pk_null: { publicKeyHex: null },
      pinned_bad_hex: { pinnedKeys: [{ signing_key_id: key.kid, public_key_hex: 'nothex' }] },
      pinned_short: { pinnedKeys: [{ signing_key_id: key.kid, public_key_hex: 'aa' }] },
      pinned_empty: { pinnedKeys: [] },
      pinned_number_hex: { pinnedKeys: [{ signing_key_id: key.kid, public_key_hex: 7 }] },
      rekor_logs_garbage: { pinnedKeys: pinned, rekorLogs: [{ name: 'x', spki: new Uint8Array(3), algorithm: 'ecdsa-p256' }], anchorEvidence: { uuid: 'x' } },
    };
    const out = {};
    for (const [k, v] of Object.entries(inputs)) {
      const r = await attempt(() => V.verifyAerBundle(bundle, v));
      out[k] = r.threw ? { threw: r.error } : { ok: r.value.ok, reasons: r.value.reasons };
    }
    return out;
  },
  anchor_none: () => V.verifyAerBundle(bundle, { pinnedKeys: pinned }),
  anchor_claimed: () => { const b = clone(bundle); b.integrity.anchored = true; return V.verifyAerBundle(b, { pinnedKeys: pinned }); },
  anchor_claimed_required: () => { const b = clone(bundle); b.integrity.anchored = true; return V.verifyAerBundle(b, { pinnedKeys: pinned, policy: { requireAnchor: true } }); },
  anchor_verified: () => {
    const b = clone(bundle); b.integrity.anchored = true;
    const { evidence, rekorLogs } = makeAnchor(key, bundle);
    return V.verifyAerBundle(b, { pinnedKeys: pinned, anchorEvidence: evidence, rekorLogs, policy: { requireAnchor: true } });
  },
  anchor_log_not_pinned: () => {
    const b = clone(bundle); b.integrity.anchored = true;
    const { evidence } = makeAnchor(key, bundle);
    const foreign = makeAnchor(key, bundle).rekorLogs; // a different log key under the same name
    return V.verifyAerBundle(b, { pinnedKeys: pinned, anchorEvidence: evidence, rekorLogs: foreign });
  },
  anchor_builtin_root_rejects_self_minted: () => {
    const b = clone(bundle); b.integrity.anchored = true;
    const { evidence } = makeAnchor(key, bundle);
    return V.verifyAerBundle(b, { pinnedKeys: pinned, anchorEvidence: evidence, rekorLogs: V.builtinTrustRoot().rekorLogs });
  },
  anchor_aer_key_only_fallback: () => {
    // The anchor must chain to a PINNED AER key; a served fallback key is not enough.
    const b = clone(bundle); b.integrity.anchored = true;
    const { evidence, rekorLogs } = makeAnchor(key, bundle);
    return V.verifyAerBundle(b, { publicKeyHex: key.rawHex, anchorEvidence: evidence, rekorLogs });
  },
  anchor_tampered_body: () => {
    const b = clone(bundle); b.integrity.anchored = true;
    const { evidence, rekorLogs } = makeAnchor(key, bundle);
    const body = JSON.parse(Buffer.from(evidence.body, 'base64')); body.spec.payloadHash.value = '00'.repeat(32);
    evidence.body = b64(Buffer.from(JSON.stringify(body)));
    return V.verifyAerBundle(b, { pinnedKeys: pinned, anchorEvidence: evidence, rekorLogs });
  },
  anchor_other_bundle: () => {
    // Genuine evidence for a DIFFERENT record must not anchor this one.
    const b = clone(bundle); b.integrity.anchored = true;
    const { evidence, rekorLogs } = makeAnchor(key, makeBundle(key));
    return V.verifyAerBundle(b, { pinnedKeys: pinned, anchorEvidence: evidence, rekorLogs });
  },
  anchor_missing_body_claimed: () => {
    const b = clone(bundle); b.integrity.anchored = true;
    const { evidence, rekorLogs } = makeAnchor(key, bundle); delete evidence.body;
    return V.verifyAerBundle(b, { pinnedKeys: pinned, anchorEvidence: evidence, rekorLogs });
  },
  anchor_malformed_flag: () => V.verifyAerBundle(bundle, { pinnedKeys: pinned, anchorEvidenceMalformed: true }),
  async anchor_hostile_evidence() {
    const { rekorLogs } = makeAnchor(key, bundle);
    const inputs = { string: 'garbage', number: 5, array: [], empty: {}, uuid_only: { uuid: 'ab' },
      bad_proof: { uuid: 'aa'.repeat(32), verification: { inclusionProof: { logIndex: -1, treeSize: 'x', rootHash: 5, hashes: 'no', checkpoint: 1 } } },
      bad_checkpoint: { uuid: 'aa'.repeat(32), verification: { inclusionProof: { logIndex: 0, treeSize: 1, rootHash: 'aa'.repeat(32), hashes: [], checkpoint: 'no separator' } } } };
    const out = {};
    for (const [k, v] of Object.entries(inputs)) {
      const r = await attempt(() => V.verifyAerBundle(bundle, { pinnedKeys: pinned, anchorEvidence: v, rekorLogs }));
      out[k] = r.threw ? { threw: r.error } : { ok: r.value.ok, status: r.value.checks.anchor.status };
    }
    return out;
  },
  builtin_trust_root: () => {
    const t = V.builtinTrustRoot();
    return { rekorLogs: t.rekorLogs.length, names: t.rekorLogs.map((k) => k.name), aerKeys: (t.aerSigningKeys || []).length };
  },
};

const fn = S[scenario];
if (!fn) { console.log(JSON.stringify({ threw: true, error: 'unknown scenario ' + scenario })); process.exit(0); }
const r = await attempt(fn);
console.log(JSON.stringify(r.threw ? r : { threw: false, value: r.value && r.value.checks ? verdict(r.value) : r.value }));
`;

async function scenario(c, name) {
  const r = await c.node(SCRIPT, { extraEnv: { MX_SCENARIO: name } });
  c.assert.exit(r, 0, `scenario ${name}`);
  c.assert.ok(r.json, `scenario ${name} printed no JSON: ${r.stdout.slice(-300)} ${r.stderr.slice(-300)}`);
  c.assert.ok(!r.json.threw, `scenario ${name} threw: ${r.json.error}`);
  return r.json.value;
}

const has = (v, reason) => Array.isArray(v.reasons) && v.reasons.includes(reason);

export default function register(registry) {
  const t = registry.suite('aer-verify', PKG);

  t.case('canonicalizer matches an independent sorted-key encoding', async (c) => {
    const v = await scenario(c, 'canonical_parity');
    c.assert.ok(v.pkg && v.hash, `canonicalize parity ${JSON.stringify(v)}`);
  });

  t.case('good bundle verifies with a fallback key (key_pinned false)', async (c) => {
    const v = await scenario(c, 'good_fallback_key');
    c.assert.equal(v.ok, true, `verdict ${JSON.stringify(v.reasons)}`);
    c.assert.ok(v.checks.hash_match && v.checks.signature_valid && v.checks.key_id_binding, JSON.stringify(v.checks));
    c.assert.equal(v.checks.key_pinned, false, 'key_pinned');
    c.assert.equal(v.anchor.status, 'none', 'anchor status');
  });

  t.case('good bundle verifies against a pinned key', async (c) => {
    const v = await scenario(c, 'good_pinned');
    c.assert.equal(v.ok, true, `verdict ${JSON.stringify(v.reasons)}`);
    c.assert.equal(v.checks.key_pinned, true, 'key_pinned');
    c.assert.equal(v.reasons.length, 0, 'reasons');
  });

  const denies = [
    ['a key outside the pinned set is refused', 'wrong_pinned', 'key_not_pinned'],
    ['a key that does not match the key id is refused', 'wrong_key', 'key_id_binding_mismatch'],
    ['no key at all is refused', 'no_key', 'key_not_pinned'],
    ['a tampered field fails the hash', 'tampered_field', 'hash_mismatch'],
    ['a tampered and rehashed body fails the signature', 'tampered_rehashed', 'signature_invalid'],
    ['a replaced signature fails', 'tampered_signature', 'signature_invalid'],
    ['a swapped signing key id fails the binding', 'swapped_key_id', 'key_id_binding_mismatch'],
  ];
  for (const [title, name, reason] of denies) {
    t.case(title, async (c) => {
      const v = await scenario(c, name);
      c.assert.equal(v.ok, false, `${name} ok`);
      c.assert.ok(has(v, reason), `${name} reasons ${JSON.stringify(v.reasons)}, expected ${reason}`);
      c.note(`reasons: ${v.reasons.join(', ')}`);
    });
  }

  t.case('hostile bundles return a failed verdict and never throw', async (c) => {
    const v = await scenario(c, 'hostile_bundles');
    const threw = Object.entries(v).filter(([, x]) => x.threw);
    c.assert.ok(threw.length === 0, `threw on: ${JSON.stringify(Object.fromEntries(threw))}`);
    const passed = Object.entries(v).filter(([, x]) => x.ok !== false);
    c.assert.ok(passed.length === 0, `verified a hostile input: ${passed.map(([k]) => k).join(', ')}`);
    c.note(Object.entries(v).map(([k, x]) => `${k}: ${x.reasons.join('+')}`).join('; '));
  });

  t.case('hostile key inputs return a failed verdict and never throw', async (c) => {
    const v = await scenario(c, 'hostile_keys');
    const threw = Object.entries(v).filter(([, x]) => x.threw);
    c.assert.ok(threw.length === 0, `threw on: ${JSON.stringify(Object.fromEntries(threw))}`);
    const passed = Object.entries(v).filter(([, x]) => x.ok !== false);
    c.assert.ok(passed.length === 0, `verified with a hostile key: ${passed.map(([k]) => k).join(', ')}`);
    c.note(Object.entries(v).map(([k, x]) => `${k}: ${x.reasons.join('+')}`).join('; '));
  });

  t.case('anchor: no claim and no evidence is none', async (c) => {
    const v = await scenario(c, 'anchor_none');
    c.assert.equal(v.anchor.status, 'none', 'status');
    c.assert.equal(v.ok, true, 'ok');
  });

  t.case('anchor: a claim without evidence is claimed and stays ok', async (c) => {
    const v = await scenario(c, 'anchor_claimed');
    c.assert.equal(v.anchor.status, 'claimed', 'status');
    c.assert.equal(v.ok, true, 'ok');
    c.assert.equal(v.anchored, false, 'anchored');
    c.assert.equal(v.anchor.claim_consistent, false, 'claim_consistent');
  });

  t.case('anchor: requireAnchor refuses a mere claim', async (c) => {
    const v = await scenario(c, 'anchor_claimed_required');
    c.assert.equal(v.ok, false, 'ok');
    c.assert.ok(has(v, 'anchor_required_by_policy'), JSON.stringify(v.reasons));
  });

  t.case('anchor: a full self-minted offline chain verifies', async (c) => {
    const v = await scenario(c, 'anchor_verified');
    c.assert.equal(v.anchor.status, 'verified', `status (reasons ${JSON.stringify(v.reasons)})`);
    c.assert.equal(v.anchored, true, 'anchored');
    c.assert.equal(v.ok, true, 'ok');
  });

  const anchorDenies = [
    ['anchor: a log key that is not pinned is invalid', 'anchor_log_not_pinned'],
    ['anchor: the builtin trust root rejects a self-minted log', 'anchor_builtin_root_rejects_self_minted'],
    ['anchor: a tampered Rekor body is invalid', 'anchor_tampered_body'],
    ['anchor: evidence for another record is invalid', 'anchor_other_bundle'],
    ['anchor: the malformed-evidence flag is invalid', 'anchor_malformed_flag'],
  ];
  for (const [title, name] of anchorDenies) {
    t.case(title, async (c) => {
      const v = await scenario(c, name);
      c.assert.equal(v.anchor.status, 'invalid', `${name} status`);
      c.assert.equal(v.ok, false, `${name} ok`);
      c.assert.equal(v.anchored, false, `${name} anchored`);
    });
  }

  t.case('anchor: an unpinned AER key never anchors, whatever the evidence', async (c) => {
    const v = await scenario(c, 'anchor_aer_key_only_fallback');
    c.assert.equal(v.anchored, false, 'anchored');
    c.assert.ok(v.anchor.status !== 'verified', `status ${v.anchor.status}`);
    c.note(`status ${v.anchor.status}, ok ${v.ok}`);
  });

  t.case('anchor: evidence without the Rekor body is claimed, not verified', async (c) => {
    const v = await scenario(c, 'anchor_missing_body_claimed');
    c.assert.equal(v.anchor.status, 'claimed', 'status');
    c.assert.equal(v.anchored, false, 'anchored');
  });

  t.case('anchor: hostile evidence values return a verdict and never throw', async (c) => {
    const v = await scenario(c, 'anchor_hostile_evidence');
    const threw = Object.entries(v).filter(([, x]) => x.threw);
    c.assert.ok(threw.length === 0, `threw on: ${JSON.stringify(Object.fromEntries(threw))}`);
    const verified = Object.entries(v).filter(([, x]) => x.status === 'verified');
    c.assert.ok(verified.length === 0, `anchored on hostile evidence: ${verified.map(([k]) => k).join(', ')}`);
    c.note(Object.entries(v).map(([k, x]) => `${k}: ${x.status}/${x.ok}`).join('; '));
  });

  t.case('builtin trust root loads offline with a pinned log key', async (c) => {
    const v = await scenario(c, 'builtin_trust_root');
    c.assert.ok(v.rekorLogs >= 1, `rekorLogs ${JSON.stringify(v)}`);
    c.note(`log keys: ${v.names.join(', ')}; AER keys: ${v.aerKeys}`);
  });
}
