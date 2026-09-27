/**
 * Test key material, minted in-process for every run. No real key is ever
 * read or used: each run generates fresh Ed25519 pairs and throws them away.
 */
import { generateKeyPairSync, sign as edSign, createHmac, createHash, randomUUID } from 'node:crypto';

export const b64url = (buf) => Buffer.from(buf).toString('base64url');
export const b64urlJson = (obj) => b64url(Buffer.from(JSON.stringify(obj)));

/** A fresh Ed25519 key with its public JWK and a kid. */
export function mintEd25519(kid = `mx-${randomUUID().slice(0, 8)}`) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  return {
    kid,
    publicKey,
    privateKey,
    publicJwk: { ...jwk, kid, alg: 'EdDSA', use: 'sig' },
    publicPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    publicRaw: Buffer.from(jwk.x, 'base64url'),
    /** Sign raw bytes. */
    sign: (bytes) => edSign(null, Buffer.from(bytes), privateKey),
  };
}

/**
 * Compact JWS. `header` overrides the default protected header, so a case can
 * build alg:none, a wrong typ or an unknown kid without a second helper.
 */
export function signJwt(key, payload, header = {}) {
  const h = { alg: 'EdDSA', typ: 'aer-attestation+jwt', kid: key.kid, ...header };
  const input = `${b64urlJson(h)}.${b64urlJson(payload)}`;
  if (h.alg === 'none') return `${input}.`;
  if (h.alg === 'HS256') {
    // Algorithm confusion: HMAC keyed with the public key bytes.
    const mac = createHmac('sha256', key.publicPem).update(input).digest();
    return `${input}.${b64url(mac)}`;
  }
  return `${input}.${b64url(key.sign(Buffer.from(input)))}`;
}

/** RFC 7638 thumbprint of an OKP or EC public JWK. */
export function jwkThumbprint(jwk) {
  const members = jwk.kty === 'OKP'
    ? { crv: jwk.crv, kty: jwk.kty, x: jwk.x }
    : { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y };
  return b64url(createHash('sha256').update(JSON.stringify(members)).digest());
}

export const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');
