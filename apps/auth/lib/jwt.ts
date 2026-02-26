import * as jose from 'jose';

const JWT_ISSUER = 'auth.imajin.ai';
const JWT_EXPIRY = '24h';

interface KeyPair {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
}

// Get or generate the key pair
async function loadKeyPair(): Promise<KeyPair> {
  const privateKeyHex = process.env.AUTH_PRIVATE_KEY;
  
  if (privateKeyHex) {
    const privateKeyBytes = Buffer.from(privateKeyHex, 'hex');
    const pem = `-----BEGIN PRIVATE KEY-----\n${privateKeyBytes.toString('base64')}\n-----END PRIVATE KEY-----`;
    
    // Import private key for signing
    const privateKey = await jose.importPKCS8(pem, 'EdDSA');
    
    // Ed25519 PKCS8 contains the public key in the last 32 bytes
    // PKCS8 for Ed25519: 48 bytes total, public key is bytes 16-48
    const publicKeyBytes = privateKeyBytes.slice(-32);
    const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex'); // Ed25519 SPKI header
    const spkiDer = Buffer.concat([spkiPrefix, publicKeyBytes]);
    const publicPem = `-----BEGIN PUBLIC KEY-----\n${spkiDer.toString('base64')}\n-----END PUBLIC KEY-----`;
    const publicKey = await jose.importSPKI(publicPem, 'EdDSA');
    
    return { privateKey, publicKey };
  }
  
  // For development: generate ephemeral key pair
  return jose.generateKeyPair('EdDSA');
}

// Cache the key pair
let keyPairPromise: Promise<KeyPair> | null = null;

function getKeyPair(): Promise<KeyPair> {
  if (!keyPairPromise) {
    keyPairPromise = loadKeyPair();
  }
  return keyPairPromise;
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
  const { privateKey } = await getKeyPair();
  
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
    .sign(privateKey);
  
  return jwt;
}

/**
 * Verify and decode a session token
 */
export async function verifySessionToken(token: string): Promise<SessionPayload | null> {
  try {
    const { publicKey } = await getKeyPair();
    
    const { payload } = await jose.jwtVerify(token, publicKey, {
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
