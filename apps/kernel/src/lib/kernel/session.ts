import { verifySessionToken, getSessionCookieOptions } from '@/src/lib/auth/jwt';
import { db, identities, identityChains } from '@/src/db';
import { eq } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

export interface KernelSession {
  did: string;
  handle?: string;
  type: string;
  name?: string;
  role: string;
  tier: string;
  chainVerified: boolean;
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

    const identity = await db.select().from(identities).where(eq(identities.id, session.sub)).limit(1);
    if (identity.length === 0) return null;

    const metadata = (identity[0].metadata as Record<string, unknown>) || {};
    const tier = (identity[0] as any).tier || 'soft';

    const chain = await db
      .select({ did: identityChains.did })
      .from(identityChains)
      .where(eq(identityChains.did, session.sub))
      .limit(1);
    const chainVerified = chain.length > 0;

    return {
      did: session.sub,
      handle: identity[0].handle || session.handle || undefined,
      type: identity[0].type || session.type,
      name: identity[0].name || session.name || undefined,
      role: (metadata.role as string) || 'member',
      tier,
      chainVerified,
    };
  } catch (error) {
    log.error({ err: String(error) }, 'getSessionFromCookies error');
    return null;
  }
}
