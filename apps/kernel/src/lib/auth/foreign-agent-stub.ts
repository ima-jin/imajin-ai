/**
 * Reach-only foreign agents (#2590), distinct from the onBehalfOf human.
 * Placeholder public keys cannot authenticate through normal login/PAT
 * paths; only reach verifies the foreign signer. Human accept creates the
 * full identity, without adding authority to this scoped credential.
 */
import { createHash } from 'node:crypto';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { db, identities, foreignAgentStubs, delegateGrantBearers } from '@/src/db';

export const FOREIGN_AGENT_STUB_SUBTYPE = 'foreign_agent_stub';
export const FOREIGN_AGENT_CAPABILITY = 'reach';

function aliasMatches(requesterDid: string) {
  return sql`${foreignAgentStubs.requesterAliases} @> ${JSON.stringify([requesterDid])}::jsonb`;
}
function requesterMatches(requesterDid: string, principalDid: string, publicKey?: string) {
  const key = publicKey?.toLowerCase();
  return and(
    eq(foreignAgentStubs.principalDid, principalDid),
    or(eq(foreignAgentStubs.requesterDid, requesterDid), eq(foreignAgentStubs.stubDid, requesterDid), aliasMatches(requesterDid),
      key ? eq(foreignAgentStubs.signerKey, key) : undefined,
      key ? sql`${foreignAgentStubs.signerAliases} @> ${JSON.stringify([key])}::jsonb` : undefined),
  );
}

/** Only call after verifying the requester's credential. Idempotent under concurrent first calls. */
export function resolveOrMintForeignAgentStub(requesterDid: string, principalDid: string, publicKey: string) {
  const signerKey = publicKey.toLowerCase();
  return db.transaction(async (tx) => {
    // Serialize mint/rotation/block against the existing principal, not a
    // nonexistent stub. This closes concurrent first-contact and key-rotation
    // races without leaving orphan placeholder identities behind.
    await tx.select({ id: identities.id }).from(identities).where(eq(identities.id, principalDid)).for('update');
    const matches = await tx.select().from(foreignAgentStubs).where(requesterMatches(requesterDid, principalDid, signerKey));
    const revoked = matches.find((stub) => stub.revokedAt);
    if (revoked) return revoked;
    if (matches.length > 0) {
      // A verified rotation may join two previously independent key groups.
      // Copy their union to EVERY member, so blocking any displayed alias
      // also revokes all existing credentials in the joined group.
      const requesterAliases = [...new Set([requesterDid, ...matches.flatMap((stub) => [stub.stubDid, stub.requesterDid, ...stub.requesterAliases])])];
      const signerAliases = [...new Set([signerKey, ...matches.flatMap((stub) => [stub.signerKey, ...stub.signerAliases])])];
      const updated = await tx.update(foreignAgentStubs).set({ requesterAliases, signerAliases })
        .where(requesterMatches(requesterDid, principalDid, signerKey)).returning();
      return updated[0];
    }
    const digest = createHash('sha256').update(JSON.stringify([signerKey, principalDid])).digest('hex');
    const stubDid = `did:imajin:foreign_${digest}`;
    await tx.insert(identities).values({
      id: stubDid, scope: 'actor', subtype: FOREIGN_AGENT_STUB_SUBTYPE,
      publicKey: `stub_${digest}`, tier: 'soft',
      metadata: { source: 'agent.reach', stub: true, capabilities: ['reach'], principalDid },
    });
    const [stub] = await tx.insert(foreignAgentStubs).values({
      stubDid, requesterDid, principalDid, signerKey, requesterAliases: [requesterDid, stubDid], signerAliases: [signerKey],
    }).returning();
    return stub;
  });
}

export async function findForeignAgentStub(requesterDid: string, principalDid: string, publicKey?: string) {
  const stubs = await db.select().from(foreignAgentStubs).where(requesterMatches(requesterDid, principalDid, publicKey));
  // A rotated key can match multiple old credentials; ANY tombstone wins.
  return stubs.find((stub) => stub.revokedAt) ?? stubs[0] ?? null;
}

/** Shared live check for tier adapters: no different audience or capability works. */
export async function introspectForeignAgentStub(stubDid: string, principalDid: string, capability: string): Promise<boolean> {
  if (capability !== FOREIGN_AGENT_CAPABILITY) return false;
  const [stub] = await db.select().from(foreignAgentStubs).where(and(
    eq(foreignAgentStubs.stubDid, stubDid), eq(foreignAgentStubs.principalDid, principalDid),
    eq(foreignAgentStubs.capability, FOREIGN_AGENT_CAPABILITY),
  )).limit(1);
  return !!stub && !stub.revokedAt;
}

/** Caller must authenticate as principalDid. Never clear tombstones on re-mint or promotion. */
export function blockForeignAgentStub(requesterDid: string, principalDid: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.select({ id: identities.id }).from(identities).where(eq(identities.id, principalDid)).for('update');
    const revoked = await tx.update(foreignAgentStubs).set({ revokedAt: new Date() }).where(and(
      or(eq(foreignAgentStubs.requesterDid, requesterDid), eq(foreignAgentStubs.stubDid, requesterDid), aliasMatches(requesterDid),
        eq(foreignAgentStubs.promotedTo, requesterDid)),
      eq(foreignAgentStubs.principalDid, principalDid),
    )).returning({ stubDid: foreignAgentStubs.stubDid });
    if (revoked.length > 0) {
      const surfaces = JSON.stringify([`reach:${principalDid}`]);
      await tx.update(delegateGrantBearers).set({
        status: 'revoked', tokenHash: null, revokedAt: new Date(), revokedBy: principalDid,
      }).where(and(
        inArray(delegateGrantBearers.principalDid, revoked.map((stub) => stub.stubDid)),
        sql`${delegateGrantBearers.surfaces} = ${surfaces}::jsonb`,
      ));
    }
    return revoked.length > 0;
  });
}

/** Human accept links the stub to the full identity; it never grants additional authority. */
export async function promoteForeignAgentStub(requesterDid: string, principalDid: string, agentDid: string, publicKey: string): Promise<void> {
  await db.update(foreignAgentStubs).set({ promotedTo: agentDid }).where(requesterMatches(requesterDid, principalDid, publicKey));
}
