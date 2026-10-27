import { NextRequest, NextResponse } from 'next/server';
import { createSessionToken, sessionCookieName, sessionCookieOptions, clearCookieOptions, type SessionConfig } from './session';
import { appRedirectUrl } from './redirect-url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { loadAppSigningKey } from './load-app-signing-key';
import { signBootstrapPayload } from './ed25519';

export interface ImajinAuthConfig extends SessionConfig {
  /** Imajin auth/kernel base URL (e.g. https://jin.imajin.ai) */
  authUrl: string;
  /** Registry app ID used by the login handler (not the app DID). */
  appId?: string;
  /** Registered scopes requested at consent; omitted means app defaults. */
  scopes?: string[];
  /** Public URL of this app (for redirects behind reverse proxy) */
  publicUrl?: string;
  /** Where to redirect after login (default: '/') */
  loginRedirect?: string;
  /** Where to redirect after logout (default: '/') */
  logoutRedirect?: string;
}

function redirectTo(path: string, req: NextRequest, config: ImajinAuthConfig) {
  return NextResponse.redirect(appRedirectUrl(path, req, config));
}

function stateCookieOptions(config: ImajinAuthConfig, value: string, maxAge: number) {
  return { ...sessionCookieOptions(value, config), name: `${sessionCookieName(config)}_state`, maxAge };
}

function privateRedirect(url: URL) {
  const response = NextResponse.redirect(url);
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}

/** Begin app sign-in on the app's own origin before visiting kernel consent. */
export function createLoginHandler(config: ImajinAuthConfig) {
  return async function GET() {
    sessionCookieName(config);
    if (!config.appId || !config.appDid) throw new Error('appId and appDid are required for app login');
    const state = randomBytes(32).toString('hex');
    const url = new URL(`${config.authUrl.replace(/\/$/, '')}/auth/authorize`);
    url.searchParams.set('app_id', config.appId);
    url.searchParams.set('state', state);
    if (config.scopes) url.searchParams.set('scopes', config.scopes.join(','));
    const response = privateRedirect(url);
    response.cookies.set(stateCookieOptions(config, state, 300));
    return response;
  };
}

function matchesState(state: string | null, cookie: string | undefined): boolean {
  return !!state && !!cookie && /^[a-f0-9]{64}$/.test(state) &&
    cookie.length === state.length && timingSafeEqual(Buffer.from(state), Buffer.from(cookie));
}

async function exchangeCode(code: string, state: string, config: ImajinAuthConfig) {
  if (!config.appDid) throw new Error('App identity required');
  const key = await loadAppSigningKey({ kernelUrl: config.authUrl, appDid: config.appDid });
  if (key.appDid !== config.appDid) throw new Error('App identity mismatch');
  const nonce = randomBytes(16).toString('hex');
  const timestamp = new Date().toISOString();
  const signature = signBootstrapPayload(`${config.appDid}:${code}:${nonce}:${timestamp}`, key.privateKey);
  const response = await fetch(`${config.authUrl.replace(/\/$/, '')}/auth/api/apps/token`, {
    method: 'POST', redirect: 'error', cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appDid: config.appDid, code, state, nonce, timestamp, signature }),
  });
  if (!response.ok) throw new Error('Authorization exchange failed');
  const body = await response.json();
  if (typeof body?.subjectDid !== 'string' || !body.subjectDid.startsWith('did:') ||
      typeof body.attestationId !== 'string' || !body.attestationId ||
      typeof body.token !== 'string' || !body.token) {
    throw new Error('Invalid authorization response');
  }
  return { subjectDid: body.subjectDid as string, attestationId: body.attestationId as string };
}

/** Create the GET handler for /api/auth/callback. No session precedes exchange. */
export function createCallbackHandler(config: ImajinAuthConfig) {
  return async function GET(req: NextRequest) {
    const name = sessionCookieName(config);
    const code = req.nextUrl.searchParams.get('code');
    const state = req.nextUrl.searchParams.get('state');
    const destination = appRedirectUrl(config.loginRedirect ?? '/', req, config);
    const response = privateRedirect(destination);
    response.cookies.set(stateCookieOptions(config, '', 0));
    try {
      if (!code || !/^[a-f0-9]{64}$/.test(code) ||
          !matchesState(state, req.cookies.get(`${name}_state`)?.value)) {
        throw new Error('Authorization state required');
      }
      const { subjectDid, attestationId } = await exchangeCode(code, state!, config);
      const profileRes = await fetch(
        `${config.authUrl}/profile/api/profile/${encodeURIComponent(subjectDid)}`,
        { redirect: 'error', cache: 'no-store' },
      );
      if (!profileRes.ok) throw new Error('Profile unavailable');
      const profile = await profileRes.json();
      const token = await createSessionToken({
        did: subjectDid,
        displayName: profile.displayName ?? profile.handle ?? subjectDid,
        handle: profile.handle ?? subjectDid,
        avatar: profile.avatar?.startsWith('/') ? `${config.authUrl}${profile.avatar}` : profile.avatar,
        attestationId,
      }, config);
      response.cookies.set(sessionCookieOptions(token, config));
      return response;
    } catch {
      // Do not surface provider errors or callback material in logs or redirects.
      destination.searchParams.set('auth_error', 'authorization_invalid');
      const failure = privateRedirect(destination);
      failure.cookies.set(stateCookieOptions(config, '', 0));
      return failure;
    }
  };
}

/** Create the GET handler for /api/auth/session */
export function createSessionHandler(config: ImajinAuthConfig) {
  return async function GET() {
    const name = sessionCookieName(config);
    const { cookies: getCookies } = await import('next/headers');
    const cookieStore = await getCookies();
    const token = cookieStore.get(name)?.value;
    if (!token) {
      return NextResponse.json(null);
    }
    const { verifySessionToken } = await import('./session');
    const user = await verifySessionToken(token, config);
    return NextResponse.json(user);
  };
}

/** Create the POST handler for /api/auth/logout */
export function createLogoutHandler(config: ImajinAuthConfig) {
  return function POST(req: NextRequest): Promise<NextResponse> {
    // Keep the Promise contract: a synchronous throw becomes a rejection.
    return new Promise<NextResponse>((resolve) => {
      sessionCookieName(config);
      const res = redirectTo(config.logoutRedirect ?? '/', req, config);
      res.cookies.set(clearCookieOptions(config));
      resolve(res);
    });
  };
}
