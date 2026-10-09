/**
 * An app calling as itself (#2747): resolve a Bearer `app-service+jwt` to the
 * app DID behind it, for the routes that accept an app's own credential
 * (media `requireMediaAuth`, attestations `resolveCallerDid`).
 *
 * The caller IS the app: the token's `sub` is the app DID, never a user, so
 * anything the app writes is owned by — and attributed to — the app DID.
 *
 * Verification is the token's EdDSA signature, expiry, `typ`, audience and
 * `sub === azp` (`verifyAppServiceToken`), plus a live registry check on every
 * call — the app must still be `active` — so revoking an app stops its
 * already-minted service tokens here at once rather than at their 10-minute TTL
 * (same stance as the session-app path, #1990).
 */
import { eq } from 'drizzle-orm';
import { db, registryApps } from '@/src/db';
import { createLogger } from '@imajin/logger';
import { verifyAppServiceToken, type AppServiceCaller } from './jwt';

/** `null` when `token` is not a live app-service token of a registered, active app. */
export async function resolveAppServiceCaller(token: string): Promise<AppServiceCaller | null> {
  const caller = await verifyAppServiceToken(token);
  if (!caller) return null;
  try {
    const [app] = await db
      .select({ status: registryApps.status })
      .from(registryApps)
      .where(eq(registryApps.appDid, caller.appDid))
      .limit(1);
    return app?.status === 'active' ? caller : null;
  } catch (err) {
    createLogger('kernel').error({ err: String(err), appDid: caller.appDid }, 'resolveAppServiceCaller: registry lookup failed');
    return null;
  }
}
