import { NextRequest, NextResponse } from 'next/server';
import { and, eq, isNotNull, lt } from 'drizzle-orm';
import { publish } from '@imajin/bus';
import { createLogger } from '@imajin/logger';
import { db, vaultDelegationGrants } from '@/src/db';
import { eraseInactiveGrantKeyMaterial } from '@/src/lib/vault';
import { getNodeSigningIdentity } from '@/src/lib/vault/sealing';

const log = createLogger('kernel');

/**
 * This route mutates the database and must never be evaluated at build time.
 *
 * Without this, Next statically prerenders it: the only request access below is
 * guarded by `if (cronSecret)`, so with `CRON_SECRET` unset the handler looks
 * static and Next runs the sweep during `next build` — issuing UPDATEs against
 * whatever database the build environment points at, and baking the resulting
 * response into a static file instead of running the sweep per invocation.
 */
export const dynamic = 'force-dynamic';

/**
 * GET /api/cron/vault-grant-expiry — sweep expired-but-still-active delegation grants.
 *
 * Vercel Cron job (schedule: "0 * * * *" — hourly). Registered in vercel.json.
 * Protected by Authorization: Bearer {CRON_SECRET}.
 *
 * Expiry is already fail-safe at read time (SQL filter in fetchActiveGrant inside
 * loadAndUnseal), but `active` rows accumulate in the DB as the expiry wall-clock
 * passes.  This sweep cleans them up so the DB reflects true revocation state.
 *
 * It also erases the wrapped key material of the grants it expires. Without that,
 * an expired grant still carries a usable field key for anyone with `nodeXPriv`
 * and database access, so expiry would bound nothing in practice — which is what
 * makes short-lived grants worth having at all. The owner's copy in
 * `vault_owner_envelopes` is what a renewal is later issued from.
 *
 * Bus event: mirrors vault.delegation.revoked from POST /api/vault/delegation/revoke.
 */
export async function GET(request: NextRequest) {
  // Validate Vercel CRON_SECRET.  When CRON_SECRET is unset (local dev),
  // any request is allowed so the route can be exercised manually.
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  try {
    const identity = getNodeSigningIdentity();
    const now = new Date();

    const swept = await db
      .update(vaultDelegationGrants)
      .set({ status: 'revoked', revokedAt: now })
      .where(
        and(
          eq(vaultDelegationGrants.status, 'active'),
          isNotNull(vaultDelegationGrants.expiresAt),
          lt(vaultDelegationGrants.expiresAt, now),
        ),
      )
      .returning();

    const erasedGrantIds = await eraseInactiveGrantKeyMaterial(swept);

    // Emit vault.delegation.revoked per row — mirrors POST /api/vault/delegation/revoke.
    for (const grant of swept) {
      publish('vault.delegation.revoked', {
        issuer: identity.senderDid,
        subject: grant.subject,
        scope: 'vault',
        payload: {
          grantId: grant.id,
          field: grant.field,
          subject: grant.subject,
          grantedTo: grant.grantedTo,
          context_id: grant.id,
          context_type: 'vault.delegation',
        },
      }).catch((err: unknown) => {
        log.error(
          { err: String(err), grantId: grant.id },
          'Bus publish error for vault.delegation.revoked (expiry sweep)',
        );
      });
    }

    log.info(
      { swept: swept.length, keyMaterialErased: erasedGrantIds.length },
      'Vault grant expiry sweep complete',
    );

    return NextResponse.json({
      ok: true,
      swept: swept.length,
      keyMaterialErasedCount: erasedGrantIds.length,
      grantIds: swept.map((g) => g.id),
    });
  } catch (error) {
    log.error({ err: String(error) }, 'Vault grant expiry sweep failed');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
