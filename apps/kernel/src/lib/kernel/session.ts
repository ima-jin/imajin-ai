import { verifySessionToken, getSessionCookieOptions } from '@/src/lib/auth/jwt';
import { db, identities, identityChains } from '@/src/db';
import { eq } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

export interface KernelSession {
  did: string;
  handle?: string;
  scope: string;
  subtype?: string;
  name?: string;
  role: string;
  tier: string;
  chainVerified: boolean;
}

/**
 * Resolve a `KernelSession` directly from a DID, bypassing the session
 * cookie entirely.
 *
 * Extracted from `getSessionFromCookies` (#1793) so app-authenticated
 * callers — whose identity comes from `requireAppAuth`'s `appAuth.userDid`
 * rather than a session cookie — can be resolved to the same shape (tier,
 * handle, role, chain-verification) that cookie-based session callers get.
 * Returns null when the DID does not correspond to a known identity.
 */
export async function getSessionForDid(did: string): Promise<KernelSession | null> {
  try {
    const identity = await db.select().from(identities).where(eq(identities.id, did)).limit(1);
    if (identity.length === 0) return null;

    const metadata = (identity[0].metadata as Record<string, unknown>) || {};
    const tier = (identity[0] as any).tier || 'soft';

    const chain = await db
      .select({ did: identityChains.did })
      .from(identityChains)
      .where(eq(identityChains.did, did))
      .limit(1);
    const chainVerified = chain.length > 0;

    return {
      did,
      handle: identity[0].handle || undefined,
      scope: identity[0].scope,
      subtype: identity[0].subtype || undefined,
      name: identity[0].name || undefined,
      role: (metadata.role as string) || 'member',
      tier,
      chainVerified,
    };
  } catch (error) {
    log.error({ err: String(error) }, 'getSessionForDid error');
    return null;
  }
}

/**
 * Verify a session cookie header and return the session data.
 * Mirrors the logic from app/auth/api/session/route.ts GET handler.
 * Returns null if not authenticated or session is invalid.
 */
export async function getSessionFromCookies(cookieHeader: string | null): Promise<KernelSession | null> {
  try {
    const cookieConfig = getSessionCookieOptions();
    const cookieName = cookieConfig.name;

    let token: string | null = null;
    if (cookieHeader) {
      for (const part of cookieHeader.split(';')) {
        const eqIdx = part.indexOf('=');
        if (eqIdx === -1) continue;
        const name = part.slice(0, eqIdx).trim();
        if (name === cookieName) {
          token = decodeURIComponent(part.slice(eqIdx + 1).trim());
          break;
        }
      }
    }

    if (!token) return null;

    const session = await verifySessionToken(token);
    if (!session) return null;

    const kernelSession = await getSessionForDid(session.sub);
    if (!kernelSession) return null;

    return {
      ...kernelSession,
      handle: kernelSession.handle || session.handle || undefined,
      scope: kernelSession.scope || session.scope,
      subtype: kernelSession.subtype || session.subtype || undefined,
      name: kernelSession.name || session.name || undefined,
    };
  } catch (error) {
    log.error({ err: String(error) }, 'getSessionFromCookies error');
    return null;
  }
}
