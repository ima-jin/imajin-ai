import { resolveCorpusDid as resolveSourceDid } from '@imajin/auth';
import type { CorpusAccessScope } from './corpus-access-claim';
import { forEachSequential } from '../async/sequential';

/** Resolve identity, not authority. A source reference never grants access. */
export function resolveCorpusDid(source: string, principalDid: string, options: { createIfMissing?: boolean } = {}): Promise<string> {
  return resolveSourceDid(source, principalDid, async owner => {
    const { db, attestations, identities } = await import('@/src/db');
    const { sql, eq } = await import('drizzle-orm');
    const { identityRepo } = await import('../registry/identity-repo');
    const { resolveOrMintIdentity } = await import('../registry/identity-alias');
    const { prepareMechanicalAttestation } = await import('../auth/emit-mechanical-attestation');
    return db.transaction(async tx => {
      // Also serializes alias publication with identity creation: no half-created stub.
      const lockKey = `corpus:github:${owner}`;
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
      const repo = identityRepo(null, tx);
      const ref = `org:${owner}`;
      const existingDid = options.createIfMissing === false ? await repo.findAlias('github', ref) : null;
      if (options.createIfMissing === false && !existingDid) throw new Error('Corpus source owner does not exist');
      const result = existingDid ? { did: existingDid, minted: false } : await resolveOrMintIdentity(repo, {
        namespace: 'github', ref, type: 'organization', metadata: {},
      });
      if ('error' in result) throw new Error(result.error);
      const [group] = await tx.select({ scope: identities.scope, suspendedAt: identities.suspendedAt })
        .from(identities).where(eq(identities.id, result.did)).limit(1);
      if (group?.scope !== 'business' || group.suspendedAt) throw new Error('Corpus owner must be an active group identity');
      if (result.minted) {
        await tx.insert(attestations).values(await prepareMechanicalAttestation({
          subjectDid: result.did, type: 'identity.created',
          contextId: result.did, contextType: 'identity',
          payload: { source: 'corpus', namespace: 'github', ref: `org:${owner}`, scope: 'business', tier: 'soft' },
        }));
      }
      return result.did;
    });
  });
}

export async function authorizeCorpusOwner(principalDid: string, ownerDid: string, scope: CorpusAccessScope): Promise<boolean> {
  if (principalDid === ownerDid) return true;
  const { introspectGrant } = await import('../auth/grants');
  const grant = await introspectGrant({
    agentDid: principalDid, delegatorDid: ownerDid, targetDid: ownerDid, capability: scope,
  });
  return grant.authorized;
}

/** Discovery is not authorization: every returned owner is checked again on use. */
export async function grantedCorpusOwners(principalDid: string): Promise<string[]> {
  const { db, delegationGrants } = await import('@/src/db');
  const { and, eq, gt } = await import('drizzle-orm');
  const grants = await db.select({ did: delegationGrants.delegatorDid }).from(delegationGrants)
    .where(and(eq(delegationGrants.agentDid, principalDid), eq(delegationGrants.status, 'active'), gt(delegationGrants.expiresAt, new Date())));
  const owners = [...new Set(grants.map(row => row.did))];
  const authorized: string[] = [];
  await forEachSequential(owners, async did => {
    if (did !== principalDid && await authorizeCorpusOwner(principalDid, did, 'corpus:read')) authorized.push(did);
  });
  return authorized;
}
