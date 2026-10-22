import { and, asc, eq, like, lte, ne, sql } from 'drizzle-orm';
import { db, attestations, registryApps } from '@/src/db';
import { prepareMechanicalAttestation } from '@/src/lib/auth/emit-mechanical-attestation';
import { forEachSequential } from '@/src/lib/async/sequential';

export const DCR_EXPIRY_TTL_DAYS = 7;
export const DCR_EXPIRY_BATCH_SIZE = 100;

function eligible(cutoff: Date) {
  return and(
    eq(registryApps.status, 'active'),
    like(registryApps.appDid, 'did:imajin:mcp-%'),
    ne(registryApps.tier, 'first_party'),
    lte(registryApps.createdAt, cutoff),
    // Historical consent counts too, including revoked and expired grants.
    sql`not exists(select 1 from auth.attestations
      where subject_did = ${registryApps.appDid} and type = 'app.authorized')`,
    sql`not exists(select 1 from kernel.app_provisions where app_did = ${registryApps.appDid})`,
    sql`not exists(select 1 from kernel.app_signing_key_claims where app_did = ${registryApps.appDid})`,
  );
}

/** Old registrations need no backfill: the first ticks apply this same policy. */
export async function expireRegistryApps(now = Date.now()): Promise<{ checked: number; expired: number }> {
  const cutoff = new Date(now - DCR_EXPIRY_TTL_DAYS * 86_400_000);
  return db.transaction(async tx => {
    const rows = await tx.select({
      id: registryApps.id, appDid: registryApps.appDid, createdAt: registryApps.createdAt,
    }).from(registryApps).where(eligible(cutoff))
      .orderBy(asc(registryApps.createdAt), asc(registryApps.id))
      .limit(DCR_EXPIRY_BATCH_SIZE).for('update', { skipLocked: true });
    let expired = 0;
    await forEachSequential(rows, async row => {
      const event = await prepareMechanicalAttestation({
        subjectDid: row.appDid,
        type: 'registry.app.expired',
        contextId: row.id,
        contextType: 'registry_app',
        payload: {
          appId: row.id, reason: 'dcr-unconsented-ttl',
          ttlDays: DCR_EXPIRY_TTL_DAYS, createdAt: row.createdAt!.toISOString(),
        },
      });
      // Recheck history after locking; another tick cannot emit a duplicate.
      const changed = await tx.update(registryApps).set({
        status: 'expired', revokedAt: event.issuedAt, updatedAt: event.issuedAt,
      }).where(and(eq(registryApps.id, row.id), eligible(cutoff))).returning({ id: registryApps.id });
      if (!changed.length) return;
      // A signing or insert failure rolls back the entire bounded tick.
      await tx.insert(attestations).values(event);
      expired++;
    });
    return { checked: rows.length, expired };
  });
}
