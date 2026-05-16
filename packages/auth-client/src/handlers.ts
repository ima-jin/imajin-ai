import { NextRequest, NextResponse } from 'next/server';
import { createSessionToken, sessionCookieOptions, clearCookieOptions, type SessionConfig, type SessionUser } from './session';

export interface ImajinAuthConfig extends SessionConfig {
  /** Imajin auth/kernel base URL (e.g. https://jin.imajin.ai) */
  authUrl: string;
  /** App DID for X-App-DID header */
  appDid?: string;
  /** Public URL of this app (for redirects behind reverse proxy) */
  publicUrl?: string;
  /** Where to redirect after login (default: '/') */
  loginRedirect?: string;
  /** Where to redirect after logout (default: '/') */
  logoutRedirect?: string;
}

function redirectTo(path: string, req: NextRequest, config: ImajinAuthConfig) {
  const base = config.publicUrl || req.nextUrl.origin;
  return NextResponse.redirect(new URL(path, base));
}

/** Create the GET handler for /api/auth/callback */
export function createCallbackHandler(config: ImajinAuthConfig) {
  return async function GET(req: NextRequest) {
    const attestationId = req.nextUrl.searchParams.get('attestation_id');
    const userDid = req.nextUrl.searchParams.get('user_did');

    if (!attestationId || !userDid) {
      return redirectTo(`${config.loginRedirect ?? '/'}?auth_error=missing_params`, req, config);
    }

    let profileData: {
      did: string;
      displayName?: string;
      handle?: string;
      avatar?: string;
    };

    try {
      const profileRes = await fetch(
        `${config.authUrl}/profile/api/profile/${encodeURIComponent(userDid)}`,
        { headers: { 'Content-Type': 'application/json' } }
      );

      if (profileRes.status === 403) {
        return redirectTo(`${config.loginRedirect ?? '/'}?auth_error=attestation_revoked`, req, config);
      }

      if (!profileRes.ok) {
        console.error('Profile fetch failed:', profileRes.status, await profileRes.text().catch(() => ''));
        return redirectTo(`${config.loginRedirect ?? '/'}?auth_error=profile_fetch_failed`, req, config);
      }

      profileData = await profileRes.json();
    } catch (err) {
      console.error('Profile fetch error:', err);
      return redirectTo(`${config.loginRedirect ?? '/'}?auth_error=network_error`, req, config);
    }

    // Resolve relative avatar URLs against the kernel
    let avatar = profileData.avatar;
    if (avatar && avatar.startsWith('/')) {
      avatar = `${config.authUrl}${avatar}`;
    }

    const token = await createSessionToken({
      did: profileData.did,
      displayName: profileData.displayName ?? profileData.handle ?? profileData.did,
      handle: profileData.handle ?? profileData.did,
      avatar,
      attestationId,
    }, config);

    const res = redirectTo(config.loginRedirect ?? '/', req, config);
    res.cookies.set(sessionCookieOptions(token, config));
    return res;
  };
}

/** Create the GET handler for /api/auth/session */
export function createSessionHandler(config: ImajinAuthConfig) {
  return async function GET() {
    const { cookies: getCookies } = await import('next/headers');
    const cookieStore = getCookies();
    const token = cookieStore.get(config.cookieName ?? 'imajin_session')?.value;
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
  return async function POST(req: NextRequest) {
    const res = redirectTo(config.logoutRedirect ?? '/', req, config);
    res.cookies.set(clearCookieOptions(config));
    return res;
  };
}
