import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Identity } from '@imajin/auth';
import { db, attestations, channelLinks, connectors, identityMembers } from '@/src/db';
import { prepareMechanicalAttestation } from '@/src/lib/auth/emit-mechanical-attestation';
import { deleteSecretAndRevokeGrants } from '@/src/lib/vault/delete-secret';
import { forEachSequential } from '@/src/lib/async/sequential';
import { connectionSlot, connectionVaultField } from './connection-slots';

export class ConnectionRemovalError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Recheck and lock live authority; a cached actingAsRole is not custody authority. */
async function removalAuthority(tx: Transaction, ownerDid: string, provider: string, actor: Identity) {
  if (!actor.id || actor.actingFor) throw new ConnectionRemovalError(403, 'Owner approval is required for credential removal.');
  const provenance = { actorDid: actor.id, delegateDid: null, actingFor: null };
  if (ownerDid === actor.id) return { ...provenance, authorityBasis: 'self', groupRole: null };
  if (actor.actingAs !== ownerDid) throw new ConnectionRemovalError(403, 'Not authorized to remove this connection.');
  const memberships = await tx.select({
    role: identityMembers.role, allowedServices: identityMembers.allowedServices,
  }).from(identityMembers).where(and(
    eq(identityMembers.identityDid, ownerDid), eq(identityMembers.memberDid, actor.id),
    inArray(identityMembers.role, ['owner', 'admin']), isNull(identityMembers.removedAt),
  )).for('share');
  const membership = memberships.find(row => row.allowedServices === null || row.allowedServices.includes(provider));
  if (!membership) throw new ConnectionRemovalError(403, 'A current owner or admin with access to this service is required.');
  return { ...provenance, authorityBasis: 'group-role', groupRole: membership.role };
}

/**
 * Remove from the live list, never from history. The row lock serializes retries;
 * a failed vault/signing/write operation must not report a successful removal.
 * Vault destruction uses its own signed tombstone + grant key-erasure API.
 */
export function removeConnectorConnection(
  ownerDid: string,
  provider: string,
  slot: string,
  vaultPrefixes: readonly string[],
  actor: Identity,
) {
  const selected = connectionSlot(slot);
  if (selected === 'primary') {
    throw new ConnectionRemovalError(409, 'Primary connection cannot be removed. Disconnect it instead.');
  }
  return db.transaction(async tx => {
    const authority = await removalAuthority(tx, ownerDid, provider, actor);
    const tuple = and(
      eq(connectors.ownerDid, ownerDid), eq(connectors.provider, provider), eq(connectors.slot, selected),
    );
    const [row] = await tx.select().from(connectors).where(tuple).for('update');
    if (!row) throw new ConnectionRemovalError(404, 'Connection not found.');
    if (row.status === 'removed') return { removed: true, slot: selected };

    // Prepare before destroying custody: a missing signing identity fails safely.
    const audit = await prepareMechanicalAttestation({
      subjectDid: ownerDid, type: 'connector.disconnected', contextId: row.id, contextType: provider,
      payload: { ownerDid, connector: provider, slot: selected, action: 'removed', ...authority, context_id: ownerDid, context_type: provider },
    });
    await forEachSequential(vaultPrefixes, async prefix => {
      await deleteSecretAndRevokeGrants(connectionVaultField(prefix, ownerDid, selected));
    });
    const now = new Date();
    // All consumers bound to this provider/owner/slot lose their grants, not
    // just the connector's own app. Other slots and owners remain untouched.
    await tx.update(channelLinks).set({ status: 'revoked', revokedAt: now }).where(and(
      eq(channelLinks.did, ownerDid), eq(channelLinks.channel, row.channel),
      eq(channelLinks.slot, selected), eq(channelLinks.status, 'active'),
    ));
    await tx.insert(attestations).values(audit);
    await tx.update(connectors).set({
      status: 'removed', scopes: [], revokedAt: now, updatedAt: now,
    }).where(tuple);
    return { removed: true, slot: selected };
  });
}
