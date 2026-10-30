import { and, eq, gt, or } from 'drizzle-orm';
import { db, identities, identityMembers, delegationGrants, agentProvisions, challenges, attestations } from '@/src/db';
import type { DbExecutor } from '@/src/lib/vault/index';
import { controlsImportOwner } from '@/src/lib/vault/import-authority';
import { generateId } from '@/src/lib/kernel/id';
import { generateChallenge, verifySignature } from './crypto';
import { issueGrant } from './grants';
import { prepareMechanicalAttestation } from './emit-mechanical-attestation';

export class AdoptionError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'AdoptionError';
  }
}

interface AdoptionPrincipal { actorDid: string; orgDid: string }
interface AdoptionIntent extends AdoptionPrincipal {
  agentDid: string;
  capabilities: string[];
}

async function authorizeOrg(input: AdoptionPrincipal, tx: DbExecutor) {
  const [org] = await tx.select({ scope: identities.scope, suspendedAt: identities.suspendedAt })
    .from(identities).where(eq(identities.id, input.orgDid)).limit(1);
  if (!org || org.suspendedAt || !['business', 'community', 'family'].includes(org.scope)
    || input.actorDid === input.orgDid || !await controlsImportOwner(input.actorDid, input.orgDid, tx, 'auth')) {
    throw new AdoptionError('Act as an organization you administer to adopt an agent', 403);
  }
}

async function requireOrphan(agentDid: string, tx: DbExecutor) {
  const [agent] = await tx.select().from(identities).where(eq(identities.id, agentDid)).limit(1).for('update');
  if (agent?.scope !== 'actor' || agent.subtype !== 'agent' || agent.suspendedAt) {
    throw new AdoptionError('Target must be an active agent identity', 409);
  }
  const members = await tx.select({ identityDid: identityMembers.identityDid }).from(identityMembers)
    .where(or(eq(identityMembers.identityDid, agentDid), eq(identityMembers.memberDid, agentDid))).limit(1);
  const grants = await tx.select({ id: delegationGrants.id }).from(delegationGrants)
    .where(and(eq(delegationGrants.agentDid, agentDid), eq(delegationGrants.status, 'active'),
      gt(delegationGrants.expiresAt, new Date()))).limit(1);
  const provisions = await tx.select({ id: agentProvisions.id }).from(agentProvisions)
    .where(eq(agentProvisions.agentDid, agentDid)).limit(1);
  if (members.length || grants.length || provisions.length) {
    throw new AdoptionError('Agent is not an orphan: membership, active grant, or provision exists', 409);
  }
  return agent;
}

/** No private key is sent to the server. The challenge binds org, human, DID and scopes. */
export function prepareAdoption(input: AdoptionIntent) {
  return db.transaction(async tx => {
    await authorizeOrg(input, tx);
    await requireOrphan(input.agentDid, tx);
    const challengeId = generateId('adopt');
    const expiresAt = new Date(Date.now() + 5 * 60_000);
    const challenge = JSON.stringify({ purpose: 'agent.adopt:v1', ...input, nonce: generateChallenge(), expiresAt: expiresAt.toISOString() });
    // Null identityId is intentional: adoption proofs cannot be used as login challenges.
    await tx.insert(challenges).values({ id: challengeId, identityId: null, challenge, expiresAt });
    return { challengeId, challenge, expiresAt: expiresAt.toISOString() };
  });
}

export function adoptAgent(input: AdoptionPrincipal & { challengeId: string; signature: string }) {
  return db.transaction(async tx => {
    await authorizeOrg(input, tx);
    const [proof] = await tx.select().from(challenges).where(eq(challenges.id, input.challengeId)).limit(1).for('update');
    if (!proof?.id.startsWith('adopt_') || proof.usedAt || proof.expiresAt <= new Date()) {
      throw new AdoptionError('Adoption challenge missing, expired, or already used', 403);
    }
    const intent = JSON.parse(proof.challenge) as AdoptionIntent & { purpose: string };
    if (intent.purpose !== 'agent.adopt:v1' || intent.actorDid !== input.actorDid || intent.orgDid !== input.orgDid) {
      throw new AdoptionError('Adoption challenge belongs to a different principal', 403);
    }
    const agent = await requireOrphan(intent.agentDid, tx);
    if (!/^[a-f0-9]{128}$/i.test(input.signature) || !await verifySignature(proof.challenge, input.signature, agent.publicKey)) {
      throw new AdoptionError('Agent key possession proof required', 403);
    }
    // Same provision primitive, including its atomic signed grant issuance history.
    const result = await issueGrant({
      delegatorDid: input.orgDid, actorDid: input.actorDid, agentDid: agent.id,
      capabilities: intent.capabilities, audience: { type: 'all' },
    }, tx);
    if ('error' in result) throw new AdoptionError(result.error, result.status);
    const attestation = await prepareMechanicalAttestation({
      type: 'agent.adopted', subjectDid: agent.id, contextType: 'delegation_grant', contextId: result.grant.grantId,
      payload: { orgDid: input.orgDid, actorDid: input.actorDid, agentDid: agent.id,
        grantId: result.grant.grantId, challenge: proof.challenge, signature: input.signature },
    });
    await tx.insert(attestations).values(attestation);
    await tx.update(challenges).set({ usedAt: new Date() }).where(eq(challenges.id, proof.id));
    return { did: agent.id, publicKey: agent.publicKey, grant: result.grant };
  });
}
