/**
 * Reach-only foreign agents (#2590), distinct from the onBehalfOf human.
 * Placeholder public keys cannot authenticate through normal login/PAT
 * paths; only reach verifies the foreign signer. Human accept creates the
 * full identity, without adding authority to this scoped credential.
 */
import { createHash } from 'node:crypto';
import { and, eq, or, sql } from 'drizzle-orm';
import { db, identities, foreignAgentStubs } from '@/src/db';

export const FOREIGN_AGENT_STUB_SUBTYPE = 'foreign_agent_stub';
export const FOREIGN_AGENT_CAPABILITY = 'reach';

function aliasMatches(requesterDid: string) {
  return sql`${foreignAgentStubs.requesterAliases} @> ${JSON.stringify([requesterDid])}::jsonb`;
}

/** Atomic set-style accrual makes successful aliases blockable without network lookups. */
async function rememberRequesterAlias(stubDid: string, requesterDid: string): Promise<void> {
  await db.update(foreignAgentStubs).set({
    requesterAliases: sql`CASE WHEN ${aliasMatches(requesterDid)} THEN ${foreignAgentStubs.requesterAliases}
      ELSE ${foreignAgentStubs.requesterAliases} || ${JSON.stringify([requesterDid])}::jsonb END`,
  }).where(eq(foreignAgentStubs.stubDid, stubDid));
}

/** Only call after verifying the requester's credential. Idempotent under concurrent first calls. */
export async function resolveOrMintForeignAgentStub(requesterDid: string, principalDid: string, publicKey: string) {
  const signerKey = publicKey.toLowerCase();
  const existing = await findForeignAgentStub(requesterDid, principalDid, signerKey);
  if (existing) {
    await rememberRequesterAlias(existing.stubDid, requesterDid);
    return findForeignAgentStub(requesterDid, principalDid, signerKey);
  }
  const digest = createHash('sha256').update(JSON.stringify([signerKey, principalDid])).digest('hex');
  const stubDid = `did:imajin:foreign_${digest}`;
  await db.transaction(async (tx) => {
    await tx.insert(identities).values({
      id: stubDid, scope: 'actor', subtype: FOREIGN_AGENT_STUB_SUBTYPE,
      publicKey: `stub_${digest}`, tier: 'soft',
      metadata: { source: 'agent.reach', stub: true, capabilities: ['reach'], principalDid },
    }).onConflictDoNothing({ target: identities.id });
    await tx.insert(foreignAgentStubs).values({
      stubDid, requesterDid, principalDid, signerKey, requesterAliases: [requesterDid],
    }).onConflictDoNothing();
  });
  await rememberRequesterAlias(stubDid, requesterDid);
  return findForeignAgentStub(requesterDid, principalDid, signerKey);
}

export async function findForeignAgentStub(requesterDid: string, principalDid: string, publicKey?: string) {
  const [stub] = await db.select().from(foreignAgentStubs).where(and(
    or(eq(foreignAgentStubs.requesterDid, requesterDid), eq(foreignAgentStubs.stubDid, requesterDid), aliasMatches(requesterDid),
      publicKey ? eq(foreignAgentStubs.signerKey, publicKey.toLowerCase()) : undefined),
    eq(foreignAgentStubs.principalDid, principalDid),
  )).limit(1);
  return stub ?? null;
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
export async function blockForeignAgentStub(requesterDid: string, principalDid: string): Promise<boolean> {
  const revoked = await db.update(foreignAgentStubs).set({ revokedAt: new Date() }).where(and(
    or(eq(foreignAgentStubs.requesterDid, requesterDid), eq(foreignAgentStubs.stubDid, requesterDid), aliasMatches(requesterDid),
      eq(foreignAgentStubs.promotedTo, requesterDid)),
    eq(foreignAgentStubs.principalDid, principalDid),
  )).returning({ stubDid: foreignAgentStubs.stubDid });
  return revoked.length > 0;
}

/** Human accept links the stub to the full identity; it never grants additional authority. */
export async function promoteForeignAgentStub(requesterDid: string, principalDid: string, agentDid: string, publicKey: string): Promise<void> {
  await db.update(foreignAgentStubs).set({ promotedTo: agentDid }).where(and(
    or(eq(foreignAgentStubs.requesterDid, requesterDid), eq(foreignAgentStubs.signerKey, publicKey.toLowerCase())),
    eq(foreignAgentStubs.principalDid, principalDid),
  ));
}
