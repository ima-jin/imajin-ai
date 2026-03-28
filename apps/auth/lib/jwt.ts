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
    const privateKeyBytes = Buffer.from(privateKeyHex, 'hex');
    
    // Import as extractable so we can derive the public key
    const privateKey = await webcrypto.subtle.importKey(
      'pkcs8',
      privateKeyBytes,
      { name: 'Ed25519' },
      true,
      ['sign']
    );
    
    // Export as JWK, extract public component
    const jwk = await webcrypto.subtle.exportKey('jwk', privateKey);
    const publicKey = await webcrypto.subtle.importKey(
      'jwk',
      { kty: jwk.kty, crv: jwk.crv, x: jwk.x },
      { name: 'Ed25519' },
      true,
      ['verify']
    );
    
    // Re-import private key as non-extractable for jose signing
    const signingKey = await jose.importPKCS8(
      `-----BEGIN PRIVATE KEY-----\n${privateKeyBytes.toString('base64')}\n-----END PRIVATE KEY-----`,
      'EdDSA'
    );
    
    // Import public key for jose verification via SPKI
    const spkiBytes = await webcrypto.subtle.exportKey('spki', publicKey);
    const spkiPem = `-----BEGIN PUBLIC KEY-----\n${Buffer.from(spkiBytes).toString('base64')}\n-----END PUBLIC KEY-----`;
    const verifyKey = await jose.importSPKI(spkiPem, 'EdDSA');
    
    return { privateKey: signingKey, publicKey: verifyKey };
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
  tier?: 'soft' | 'preliminary' | 'established'; // identity tier
  keyId?: string;   // which key created this session
  keyRole?: string; // 'auth' | 'assert' | 'controller'
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
    tier: payload.tier || 'soft',
    ...(payload.keyId ? { keyId: payload.keyId } : {}),
    ...(payload.keyRole ? { keyRole: payload.keyRole } : {}),
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

    const rawTier = payload.tier as string || 'soft';
    const tier = rawTier === 'hard' ? 'preliminary' : rawTier as 'soft' | 'preliminary' | 'established';
    return {
      sub: payload.sub as string,
      handle: payload.handle as string | undefined,
      type: payload.type as string,
      name: payload.name as string | undefined,
      tier,
      keyId: payload.keyId as string | undefined,
      keyRole: payload.keyRole as string | undefined,
    };
  } catch (error) {
    console.error('JWT verification failed:', error);
    return null;
  }
}

// Re-export from @imajin/config — auth's own callers can keep importing from here
export { getSessionCookieOptions } from '@imajin/config';

export interface MfaChallengePayload {
  sub: string;  // DID
  type: 'mfa_challenge';
  methods: string[];  // enabled MFA method types
}

export async function createMfaChallengeToken(did: string, methods: string[]): Promise<string> {
  const { privateKey } = await getKeyPair();
  return new jose.SignJWT({ type: 'mfa_challenge', methods })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setSubject(did)
    .setIssuer(JWT_ISSUER)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

export async function verifyMfaChallengeToken(token: string): Promise<MfaChallengePayload | null> {
  try {
    const { publicKey } = await getKeyPair();
    const { payload } = await jose.jwtVerify(token, publicKey, { issuer: JWT_ISSUER });
    if (payload.type !== 'mfa_challenge') return null;
    return {
      sub: payload.sub as string,
      type: 'mfa_challenge',
      methods: payload.methods as string[],
    };
  } catch {
    return null;
  }
}
