import * as jose from 'jose';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';

// @noble/ed25519 v2 requires sha512 to be wired up explicitly in non-web environments
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(ed.etc as any).sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

// PKCS8 prefix for Ed25519 keys (16 bytes, RFC 8410):
// SEQUENCE { INTEGER 0, SEQUENCE { OID 1.3.101.112 }, OCTET STRING { OCTET STRING { <32 bytes> } } }
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
// SPKI prefix for Ed25519 public keys (12 bytes, RFC 8410):
// SEQUENCE { SEQUENCE { OID 1.3.101.112 }, BIT STRING { <32 bytes> } }
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export interface ReceiptPayload {
  iss: 'node';
  aud: string; // asset:{assetId}
  sub: string; // settlementId
  buyer: string; // buyer DID — receipt is bound to this identity (non-transferable in v1)
  action: string;
  amount: number;
  currency: string;
  manifestDigest: string;
  iat: number;
  exp: number;
}

/**
 * Sign a receipt JWT with an Ed25519 private key.
 *
 * @param payload — receipt claims (iat/exp will be added if omitted)
 * @param nodeKey — EdDSA CryptoKey or raw PKCS8 PEM
 */
export async function signReceipt(
  payload: Omit<ReceiptPayload, 'iat' | 'exp'> & Partial<Pick<ReceiptPayload, 'iat' | 'exp'>>,
  nodeKey: jose.KeyLike | Uint8Array,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const jwt = await new jose.SignJWT({
    buyer: payload.buyer,
    action: payload.action,
    amount: payload.amount,
    currency: payload.currency,
    manifestDigest: payload.manifestDigest,
  })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuer('node')
    .setAudience(payload.aud)
    .setSubject(payload.sub)
    .setIssuedAt(payload.iat ?? now)
    .setExpirationTime(payload.exp ?? now + 30 * 24 * 60 * 60)
    .sign(nodeKey);

  return jwt;
}

/**
 * Verify a receipt JWT.
 *
 * @param token — the JWT string
 * @param nodePublicKey — EdDSA public key for verification
 * @returns the decoded payload or null if invalid
 */
export async function verifyReceipt(
  token: string,
  nodePublicKey: jose.KeyLike | Uint8Array,
): Promise<ReceiptPayload | null> {
  try {
    const { payload } = await jose.jwtVerify(token, nodePublicKey, {
      issuer: 'node',
    });

    // Validate required claims
    const aud = payload.aud;
    const audStr = Array.isArray(aud) ? aud[0] : aud;
    if (typeof audStr !== 'string' || !audStr.startsWith('asset:')) {
      return null;
    }

    const sub = payload.sub;
    if (typeof sub !== 'string' || !sub) {
      return null;
    }

    const buyer = payload.buyer as unknown;
    if (typeof buyer !== 'string' || !buyer || !buyer.startsWith('did:')) {
      return null;
    }

    const action = payload.action as unknown;
    if (typeof action !== 'string' || !action) {
      return null;
    }

    const amount = payload.amount as unknown;
    if (typeof amount !== 'number' || !Number.isInteger(amount)) {
      return null;
    }

    const currency = payload.currency as unknown;
    if (typeof currency !== 'string' || !currency) {
      return null;
    }

    const manifestDigest = payload.manifestDigest as unknown;
    if (typeof manifestDigest !== 'string' || !manifestDigest) {
      return null;
    }

    return {
      iss: 'node',
      aud: audStr,
      sub,
      buyer,
      action,
      amount,
      currency,
      manifestDigest,
      iat: payload.iat ?? 0,
      exp: payload.exp ?? 0,
    };
  } catch {
    return null;
  }
}

/**
 * Load an EdDSA signing key from a hex-encoded raw private key.
 *
 * Expects AUTH_PRIVATE_KEY format: 64-byte hex string.
 */
/**
 * Suggested expiration for a receipt based on action type.
 * - reproduction: 30 days
 * - streaming: 24 hours
 * - derivative: 30 days
 * - syndication: 30 days
 */
export function receiptExpiryForAction(action: string): number {
  const now = Math.floor(Date.now() / 1000);
  if (action === 'streaming') {
    return now + 24 * 60 * 60;
  }
  return now + 30 * 24 * 60 * 60;
}

/**
 * Accepts AUTH_PRIVATE_KEY in either format:
 *   - 32-byte raw Ed25519 seed (64 hex chars)
 *   - 48-byte PKCS8 DER (96 hex chars, with 16-byte algorithm-OID prefix)
 */
function extractEd25519Seed(privateKeyHex: string): Buffer {
  const buf = Buffer.from(privateKeyHex, 'hex');
  if (buf.length === 32) return buf;
  if (buf.length === 48) return buf.subarray(16) as Buffer; // strip PKCS8 prefix
  throw new Error(`AUTH_PRIVATE_KEY must be 32- or 48-byte hex (got ${buf.length} bytes)`);
}

export async function loadSigningKey(privateKeyHex: string): Promise<jose.KeyLike> {
  const seed = extractEd25519Seed(privateKeyHex);
  const pkcs8Der = Buffer.concat([PKCS8_ED25519_PREFIX, seed]);
  const pkcs8Pem = `-----BEGIN PRIVATE KEY-----\n${pkcs8Der.toString('base64')}\n-----END PRIVATE KEY-----`;
  return jose.importPKCS8(pkcs8Pem, 'EdDSA');
}

/**
 * Derive the public verification key from a 32-byte hex-encoded private seed.
 */
export async function loadVerifyKey(privateKeyHex: string): Promise<jose.KeyLike> {
  const seed = extractEd25519Seed(privateKeyHex);
  // Derive public key from seed using @noble/ed25519
  const pubKey = await ed.getPublicKeyAsync(new Uint8Array(seed));
  const spkiDer = Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(pubKey)]);
  const spkiPem = `-----BEGIN PUBLIC KEY-----\n${spkiDer.toString('base64')}\n-----END PUBLIC KEY-----`;
  return jose.importSPKI(spkiPem, 'EdDSA');
}
