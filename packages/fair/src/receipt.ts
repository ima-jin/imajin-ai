import * as jose from 'jose';

export interface ReceiptPayload {
  iss: 'node';
  aud: string; // asset:{assetId}
  sub: string; // settlementId
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

export async function loadSigningKey(privateKeyHex: string): Promise<jose.KeyLike> {
  const privateKeyBytes = Buffer.from(privateKeyHex, 'hex');
  const pkcs8Pem = `-----BEGIN PRIVATE KEY-----\n${privateKeyBytes.toString('base64')}\n-----END PRIVATE KEY-----`;
  return jose.importPKCS8(pkcs8Pem, 'EdDSA');
}

/**
 * Derive the public verification key from a hex-encoded raw private key.
 */
export async function loadVerifyKey(privateKeyHex: string): Promise<jose.KeyLike> {
  const privateKeyBytes = Buffer.from(privateKeyHex, 'hex');

  // Import as extractable to derive public key
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    privateKeyBytes,
    { name: 'Ed25519' },
    true,
    ['sign'],
  );

  const jwk = await crypto.subtle.exportKey('jwk', privateKey);
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, crv: jwk.crv, x: jwk.x },
    { name: 'Ed25519' },
    true,
    ['verify'],
  );

  const spkiBytes = await crypto.subtle.exportKey('spki', publicKey);
  const spkiPem = `-----BEGIN PUBLIC KEY-----\n${Buffer.from(spkiBytes).toString('base64')}\n-----END PUBLIC KEY-----`;
  return jose.importSPKI(spkiPem, 'EdDSA');
}
