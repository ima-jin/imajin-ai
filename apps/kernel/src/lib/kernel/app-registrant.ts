/**
 * App registrant DID lookup (#1621, extracted for #1770).
 *
 * Looks up the DID that registered an app — the org/business/person whose
 * profile owns the app and where org-level credentials (connector keys, OAuth
 * client config) are sealed.
 */
import { createLogger } from '@imajin/logger';
import { eq } from 'drizzle-orm';
import { db, registryApps } from '@/src/db';

const log = createLogger('kernel:app-registrant');

/**
 * Resolve the registrant DID for `appDid`, or `undefined` when the app is not
 * found.
 *
 * Graceful on failure: a missing registry row or a DB error just skips this
 * hop rather than failing whatever walk called it — callers treat this as one
 * optional candidate among several (owner, app, registrant), not a fail-closed
 * gate.
 */
export async function lookupAppRegistrantDid(appDid: string): Promise<string | undefined> {
  try {
    const [row] = await db
      .select({ ownerDid: registryApps.ownerDid })
      .from(registryApps)
      .where(eq(registryApps.appDid, appDid))
      .limit(1);
    // Diagnostic for #1762/#1770: `found: false` means no registry.apps row at
    // all; `found: true` with an unexpected `registrantDid` means the row exists
    // but points somewhere other than the DID whose connector config/key is
    // sealed.
    log.info(
      { appDid, registrantDid: row?.ownerDid ?? null, found: row !== undefined },
      'app registrant lookup result',
    );
    return row?.ownerDid;
  } catch (err) {
    log.warn({ appDid, err: String(err) }, 'app registrant lookup failed — skipping');
    return undefined;
  }
}
