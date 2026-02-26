import * as jose from 'jose';
import { webcrypto } from 'crypto';

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
    // Import existing PKCS8 private key as extractable so we can derive public key
    const privateKeyBytes = Buffer.from(privateKeyHex, 'hex');
    const pem = `-----BEGIN PRIVATE KEY-----\n${privateKeyBytes.toString('base64')}\n-----END PRIVATE KEY-----`;
    
    // Import as Web Crypto key with extractable=true
    const privateKey = await webcrypto.subtle.importKey(
      'pkcs8',
      privateKeyBytes,
      { name: 'Ed25519' },
      true,
      ['sign']
    );
    
    // Export as JWK, derive public key
    const jwk = await webcrypto.subtle.exportKey('jwk', privateKey);
    delete jwk.d; // Remove private component
    const publicKey = await webcrypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'Ed25519' },
      true,
      ['verify']
    );
    
    return { privateKey, publicKey };
  }
  
  // For development: generate ephemeral key pair
  const { privateKey, publicKey } = await jose.generateKeyPair('EdDSA');
  return { privateKey, publicKey };
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
