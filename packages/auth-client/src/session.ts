import { createHash } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';

export interface SessionUser {
  did: string;
  displayName: string;
  handle: string;
  avatar?: string;
  attestationId: string;
}

export interface SessionConfig {
  /** App DID used to derive a stable, app-specific session cookie name. */
  appDid?: string;
  /** Explicit app cookie name; imajin_session is reserved for the kernel. */
  cookieName?: string;
  maxAge?: number;           // default: 7 days in seconds
  secret: string;            // SESSION_SECRET env var
  secureCookies?: boolean;   // default: process.env.NODE_ENV === 'production'
}

const DEFAULT_MAX_AGE = 60 * 60 * 24 * 7; // 7 days
export function sessionCookieName(config: SessionConfig): string {
  if (config.cookieName !== undefined) {
    if (config.cookieName === 'imajin_session') {
      throw new Error('imajin_session is reserved for the kernel session');
    }
    // A cookie name must be an HTTP token, not an empty name or cookie attributes.
    if (!config.cookieName || /[^!#$%&'*+\-.^_`|~\da-zA-Z]/.test(config.cookieName)) {
      throw new Error('cookieName must be a valid nonempty cookie name');
    }
    return config.cookieName;
  }
  if (!config.appDid?.trim()) {
    throw new Error('appDid is required to derive the app session cookie name; alternatively set cookieName');
  }
  return `imajin_app_session_${createHash('sha256').update(config.appDid).digest('hex')}`;
}

function getSecret(config: SessionConfig): Uint8Array {
  return new TextEncoder().encode(config.secret);
}

export function createSessionToken(user: SessionUser, config: SessionConfig): Promise<string> {
  // Keep the Promise contract: a synchronous throw while building the JWT becomes a rejection.
  try {
    return Promise.resolve(
      new SignJWT({ user })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime(`${config.maxAge ?? DEFAULT_MAX_AGE}s`)
        .sign(getSecret(config))
    );
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }
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
    name: sessionCookieName(config),
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
    name: sessionCookieName(config),
    value: '',
    httpOnly: true,
    secure: config.secureCookies ?? process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    maxAge: 0,
    path: '/',
  };
}
