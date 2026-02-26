import * as jose from 'jose';

const JWT_ISSUER = 'auth.imajin.ai';
const JWT_EXPIRY = '24h';

// Get or generate the signing key
// In production, this should be a persistent Ed25519 key stored in env
async function getSigningKey(): Promise<CryptoKey> {
  const privateKeyHex = process.env.AUTH_PRIVATE_KEY;
  
  if (privateKeyHex) {
    // Import existing key from hex
    const privateKeyBytes = Buffer.from(privateKeyHex, 'hex');
    return jose.importPKCS8(
      `-----BEGIN PRIVATE KEY-----\n${privateKeyBytes.toString('base64')}\n-----END PRIVATE KEY-----`,
      'EdDSA'
    );
  }
  
  // For development: generate ephemeral key (sessions won't persist across restarts)
  const { privateKey } = await jose.generateKeyPair('EdDSA');
  return privateKey;
}

// Cache the key
let signingKeyPromise: Promise<CryptoKey> | null = null;

function getKey(): Promise<CryptoKey> {
  if (!signingKeyPromise) {
    signingKeyPromise = getSigningKey();
  }
  return signingKeyPromise;
}

export interface SessionPayload {
  sub: string;      // DID
  handle?: string;  // @username
  type: string;     // identity type
  name?: string;
}

/**
 * Create a signed JWT for a session
 */
export async function createSessionToken(payload: SessionPayload): Promise<string> {
  const key = await getKey();
  
  const jwt = await new jose.SignJWT({
    handle: payload.handle,
    type: payload.type,
    name: payload.name,
  })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setSubject(payload.sub)
    .setIssuer(JWT_ISSUER)
    .setIssuedAt()
    .setExpirationTime(JWT_EXPIRY)
    .sign(key);
  
  return jwt;
}

/**
 * Verify and decode a session token
 */
export async function verifySessionToken(token: string): Promise<SessionPayload | null> {
  try {
    const key = await getKey();
    
    const { payload } = await jose.jwtVerify(token, key, {
      issuer: JWT_ISSUER,
    });
    
    return {
      sub: payload.sub as string,
      handle: payload.handle as string | undefined,
      type: payload.type as string,
      name: payload.name as string | undefined,
    };
  } catch (error) {
    console.error('JWT verification failed:', error);
    return null;
  }
}

/**
 * Cookie configuration for cross-subdomain sessions
 */
export function getSessionCookieOptions(isProduction: boolean) {
  return {
    name: 'imajin_session',
    options: {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax' as const,
      path: '/',
      domain: '.imajin.ai',
      maxAge: 60 * 60 * 24, // 24 hours
    },
  };
}
