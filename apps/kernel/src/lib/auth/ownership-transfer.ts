import { and, eq, isNull } from 'drizzle-orm';
import type { Identity } from '@imajin/auth';
import { evaluateDelegationPolicy } from '@imajin/auth/delegation-policy';
import { db, identities, identityMembers, attestations, nodeConfig, profiles } from '@/src/db';
import { generateId } from '@/src/lib/kernel/id';
import { prepareMechanicalAttestation } from './emit-mechanical-attestation';
import {
  identityMetadata, OWNERSHIP_POLICY_KEY, PENDING_OWNER_TRANSFER_KEY,
  readPendingTransfer, resolveOwnershipPolicy, OwnershipError,
  type OwnershipPolicyRegistry, type OwnershipPolicyContext,
} from './ownership-policy';

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Actor = Pick<Identity, 'id' | 'actingFor' | 'actingAs'>;
type Operation = 'read' | 'propose' | 'cancel' | 'accept';
type TransferInput = { newOwnerDid?: string; transferId?: string };

function membershipWhere(groupDid: string, memberDid: string) {
  return and(eq(identityMembers.identityDid, groupDid), eq(identityMembers.memberDid, memberDid));
}

async function loadState(tx: Transaction, groupDid: string, registry?: OwnershipPolicyRegistry) {
  const [group] = await tx.select().from(identities).where(eq(identities.id, groupDid)).for('update');
  if (!group || !['business', 'community', 'family'].includes(group.scope)) {
    throw new OwnershipError('Group not found', 404);
  }
  if (group.suspendedAt) throw new OwnershipError('Group suspended', 403);
  const members = await tx.select().from(identityMembers)
    .where(and(eq(identityMembers.identityDid, groupDid), isNull(identityMembers.removedAt)));
  const owners = members.filter((member) => member.role === 'owner');
  if (owners.length !== 1) throw new OwnershipError('Group must have exactly one active owner', 409);
  const [config] = await tx.select({ value: nodeConfig.value }).from(nodeConfig)
    .where(eq(nodeConfig.key, OWNERSHIP_POLICY_KEY)).for('share');
  const policy = resolveOwnershipPolicy(config?.value, registry);
  return { group, members, ownerDid: owners[0].memberDid, policy, pending: readPendingTransfer(group.metadata) };
}

type State = Awaited<ReturnType<typeof loadState>>;

function context(state: State, actor: Actor, action: OwnershipPolicyContext['action']): OwnershipPolicyContext {
  return {
    action, groupDid: state.group.id, actorDid: actor.id,
    ownerDid: state.ownerDid, pendingTransfer: state.pending,
  };
}

function delegationAllowed(actor: Actor): boolean {
  return evaluateDelegationPolicy(actor, { action: 'transfer-owner', class: 'value-moving' }).allowed;
}

async function humanActor(tx: Transaction, did: string): Promise<void> {
  const [identity] = await tx.select({ scope: identities.scope, subtype: identities.subtype, suspended: identities.suspendedAt })
    .from(identities).where(eq(identities.id, did)).for('share');
  if (!identity || identity.scope !== 'actor' || identity.subtype !== 'human' || identity.suspended) {
    throw new OwnershipError('Owner must be an active human actor', 400);
  }
}

async function present(state: State, actor: Actor) {
  const viewerRole = state.members.find((member) => member.memberDid === actor.id)?.role ?? null;
  if (!viewerRole && state.pending?.to !== actor.id) throw new OwnershipError('Not a member or transfer recipient', 403);
  const allowed = delegationAllowed(actor);
  return {
    groupDid: state.group.id, groupName: state.group.name, ownerDid: state.ownerDid,
    policy: state.policy.id, pendingTransfer: state.pending, viewerDid: actor.id, viewerRole,
    canTransfer: allowed && await state.policy.allows(context(state, actor, 'propose')),
    canAccept: Boolean(allowed && state.pending?.to === actor.id
      && state.pending.policy === state.policy.id && await state.policy.allows(context(state, actor, 'accept'))),
    acceptanceUrl: `/auth/groups/${encodeURIComponent(state.group.id)}/ownership`,
  };
}

function matchingPending(state: State, transferId?: string) {
  if (!state.pending || state.pending.id !== transferId || state.pending.from !== state.ownerDid) {
    throw new OwnershipError('Transfer not pending or no longer current', 409);
  }
  return state.pending;
}

async function authorize(state: State, actor: Actor, action: OwnershipPolicyContext['action']) {
  const decision = evaluateDelegationPolicy(actor, {
    action: `transfer-owner:${action}`, class: 'value-moving', resourceId: state.group.id,
  });
  if (!decision.allowed) {
    throw new OwnershipError(decision.body.error, 403, decision.body.code);
  }
  if (!await state.policy.allows(context(state, actor, action))) {
    throw new OwnershipError('Ownership policy denied this operation', 403, 'OWNERSHIP_POLICY_DENIED');
  }
}

async function writePending(tx: Transaction, state: State, pending: State['pending']) {
  const metadata = { ...identityMetadata(state.group.metadata) };
  delete metadata[PENDING_OWNER_TRANSFER_KEY];
  if (pending) metadata[PENDING_OWNER_TRANSFER_KEY] = pending;
  await tx.update(identities).set({ metadata, updatedAt: new Date() }).where(eq(identities.id, state.group.id));
  state.pending = pending;
}

async function propose(tx: Transaction, state: State, actor: Actor, newOwnerDid?: string) {
  if (state.pending) throw new OwnershipError('Cancel the pending transfer before proposing another', 409);
  if (!newOwnerDid || newOwnerDid === state.ownerDid) throw new OwnershipError('Choose a different newOwnerDid', 400);
  await humanActor(tx, newOwnerDid);
  await writePending(tx, state, {
    id: generateId('owner'), from: state.ownerDid, to: newOwnerDid, by: actor.id,
    policy: state.policy.id, createdAt: new Date().toISOString(),
  });
  return present(state, actor);
}

async function accept(tx: Transaction, state: State, actor: Actor, transferId?: string) {
  const pending = matchingPending(state, transferId);
  if (pending.to !== actor.id) throw new OwnershipError('Only the named recipient can accept', 403);
  if (pending.policy !== state.policy.id) throw new OwnershipError('Ownership policy changed; propose again', 409);
  await humanActor(tx, actor.id);
  const attestation = await prepareMechanicalAttestation({
    subjectDid: state.group.id, type: 'identity.owner.transferred',
    contextId: state.group.id, contextType: 'group',
    payload: {
      from: pending.from, to: pending.to, by: pending.by, policy: state.policy.id,
      acceptedBy: actor.id, transferId: pending.id,
    },
  });
  await tx.update(identityMembers).set({ role: 'admin', allowedServices: null }).where(
    and(membershipWhere(state.group.id, state.ownerDid), isNull(identityMembers.removedAt)),
  );
  const existing = await tx.select().from(identityMembers).where(membershipWhere(state.group.id, actor.id));
  if (existing.length > 1) throw new OwnershipError('Recipient has ambiguous memberships', 409);
  if (existing.length) {
    await tx.update(identityMembers).set({ role: 'owner', removedAt: null, allowedServices: null })
      .where(membershipWhere(state.group.id, actor.id));
  } else {
    await tx.insert(identityMembers).values({
      identityDid: state.group.id, memberDid: actor.id, role: 'owner', addedBy: pending.by, addedVia: 'invite',
    });
  }
  await writePending(tx, state, null);
  await tx.update(profiles).set({ claimedBy: actor.id, updatedAt: new Date() }).where(eq(profiles.did, state.group.id));
  await tx.insert(attestations).values(attestation);
  return { ok: true, ownerDid: actor.id, attestationId: attestation.id };
}

/** All transitions serialize on the identity row, including the DID-bound invitation acceptance. */
export async function ownershipTransfer(
  groupDid: string, actor: Actor, operation: Operation, input: TransferInput = {},
  registry?: OwnershipPolicyRegistry,
) {
  return db.transaction(async (tx) => {
    const state = await loadState(tx, groupDid, registry);
    if (operation === 'read') return present(state, actor);
    await authorize(state, actor, operation);
    if (operation === 'propose') return propose(tx, state, actor, input.newOwnerDid);
    if (operation === 'accept') return accept(tx, state, actor, input.transferId);
    matchingPending(state, input.transferId);
    await writePending(tx, state, null);
    return present(state, actor);
  });
}
