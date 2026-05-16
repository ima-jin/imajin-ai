import { SignJWT, jwtVerify } from 'jose';

export interface SessionUser {
  did: string;
  displayName: string;
  handle: string;
  avatar?: string;
  attestationId: string;
}

export interface SessionConfig {
  cookieName?: string;       // default: 'imajin_session'
  maxAge?: number;           // default: 7 days in seconds
  secret: string;            // SESSION_SECRET env var
  secureCookies?: boolean;   // default: process.env.NODE_ENV === 'production'
}

const DEFAULT_COOKIE_NAME = 'imajin_session';
const DEFAULT_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

function getSecret(config: SessionConfig): Uint8Array {
  return new TextEncoder().encode(config.secret);
}

export async function createSessionToken(user: SessionUser, config: SessionConfig): Promise<string> {
  return new SignJWT({ user })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${config.maxAge ?? DEFAULT_MAX_AGE}s`)
    .sign(getSecret(config));
}

export async function verifySessionToken(token: string, config: SessionConfig): Promise<SessionUser | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret(config));
    return payload.user as SessionUser;
  } catch {
    return null;
  }
}

export function sessionCookieOptions(token: string, config: SessionConfig) {
  return {
    name: config.cookieName ?? DEFAULT_COOKIE_NAME,
    value: token,
    httpOnly: true,
    secure: config.secureCookies ?? process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    maxAge: config.maxAge ?? DEFAULT_MAX_AGE,
    path: '/',
  };
}

export function clearCookieOptions(config: SessionConfig) {
  return {
    name: config.cookieName ?? DEFAULT_COOKIE_NAME,
    value: '',
    httpOnly: true,
    secure: config.secureCookies ?? process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    maxAge: 0,
    path: '/',
  };
}
