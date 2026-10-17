import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Identity } from '@imajin/auth';
import { db, identities, identityMembers } from '@/src/db';
import { getOperatorDid } from '@/src/lib/notify/operator-approvals';
import { getNodeSigningIdentity } from './sealing';
import type { DbExecutor } from './index';

export interface ImportOwner { did: string; name: string }

/** Scope is checked on current membership, never on the act-as cookie's cached role. */
export async function listImportOwners(personDid: string, executor: DbExecutor = db): Promise<ImportOwner[]> {
  const memberships = await executor.select({
    identityDid: identityMembers.identityDid, allowedServices: identityMembers.allowedServices,
  }).from(identityMembers).innerJoin(identities, eq(identities.id, identityMembers.identityDid)).where(and(
    eq(identityMembers.memberDid, personDid),
    inArray(identityMembers.role, ['owner', 'admin']),
    isNull(identityMembers.removedAt),
    inArray(identities.scope, ['family', 'community', 'business']),
    isNull(identities.suspendedAt),
  ));
  const dids = [...new Set([personDid, ...memberships
    .filter(row => !row.allowedServices || row.allowedServices.includes('vault'))
    .map(row => row.identityDid)])];
  const rows = await executor.select({ did: identities.id, name: identities.name })
    .from(identities).where(inArray(identities.id, dids));
  const names = new Map(rows.map(row => [row.did, row.name]));
  return dids.map(did => ({ did, name: names.get(did) || did }));
}

export async function controlsImportOwner(personDid: string, ownerDid: string, executor: DbExecutor = db): Promise<boolean> {
  return (await listImportOwners(personDid, executor)).some(owner => owner.did === ownerDid);
}

export async function isImportHuman(did: string, executor: DbExecutor = db): Promise<boolean> {
  const [person] = await executor.select({ id: identities.id }).from(identities).where(and(
    eq(identities.id, did), eq(identities.scope, 'actor'), eq(identities.subtype, 'human'),
    isNull(identities.suspendedAt),
  )).limit(1);
  return !!person;
}

/** Agents may propose for their authenticated delegator, but can never countersign. */
export async function importProposer(identity: Identity): Promise<{ personDid: string; approverDid: string } | null> {
  const personDid = identity.actingFor ?? identity.id;
  if (await isImportHuman(personDid)) return { personDid, approverDid: personDid };
  if (personDid !== getNodeSigningIdentity().senderDid) return null;
  const operatorDid = await getOperatorDid();
  if (!operatorDid || !(await isImportHuman(operatorDid))) return null;
  return { personDid, approverDid: operatorDid };
}

/** Node authority is not blanket ownership: only its own vault has this special case. */
export async function canExecuteImport(approverDid: string, ownerDid: string, executor: DbExecutor = db): Promise<boolean> {
  if (!(await isImportHuman(approverDid, executor))) return false;
  if (ownerDid === getNodeSigningIdentity().senderDid && approverDid === await getOperatorDid()) return true;
  return controlsImportOwner(approverDid, ownerDid, executor);
}
