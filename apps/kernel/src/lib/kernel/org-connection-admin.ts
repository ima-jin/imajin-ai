import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db, attestations, connectors, identities, identityMembers, orgConnectionEvents, orgConnectionSuspensions, type ConnectorRow } from '@/src/db';
import { prepareMechanicalAttestation } from '@/src/lib/auth/emit-mechanical-attestation';
import type { DocumentActor } from '@/src/lib/auth/document-authorization';
import { OwnershipError } from '@/src/lib/auth/ownership-policy';
import { generateId } from './id';
import type { ConnectionTransaction } from './member-connection-gate';

export interface SuspensionInput { action: 'suspend' | 'resume'; reason: string; connectionId?: string; provider?: string }

export function parseSuspensionInput(raw: unknown): SuspensionInput {
  const fail = () => { throw new OwnershipError('Provide action, reason and exactly one connectionId or provider', 400); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail();
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some(key => !['action', 'reason', 'connectionId', 'provider'].includes(key))) return fail();
  if (value.action !== 'suspend' && value.action !== 'resume') return fail();
  if (typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 500) return fail();
  const targets = ['connectionId', 'provider'].filter(key => value[key] !== undefined);
  if (targets.length !== 1) return fail();
  const target = value[targets[0]];
  if (typeof target !== 'string' || !target.trim() || target.length > 256 || target !== target.trim()) return fail();
  return { action: value.action, reason: value.reason.trim(), [targets[0]]: target };
}

/** Recheck live role/scope under the same org lock used by member edits and removal. */
async function requireOrgAdmin(tx: ConnectionTransaction, actor: DocumentActor) {
  const orgDid = actor.effectiveDid;
  if (orgDid === actor.actingHumanDid) throw new OwnershipError('Act as an organization to manage connections', 403);
  const [org] = await tx.select().from(identities).where(eq(identities.id, orgDid)).for('update');
  const [membership] = await tx.select().from(identityMembers).where(and(
    eq(identityMembers.identityDid, orgDid), eq(identityMembers.memberDid, actor.actingHumanDid),
    isNull(identityMembers.removedAt),
  )).limit(1);
  if (!org || !['business', 'community', 'family'].includes(org.scope) || org.suspendedAt
    || !membership || !['owner', 'admin'].includes(membership.role)
    || (membership.allowedServices !== null && !membership.allowedServices.includes('auth'))) {
    throw new OwnershipError('Active organization owner or admin required', 403);
  }
  return orgDid;
}

/** One durable scoped policy plus immutable signed evidence. No credential reads or writes. */
async function recordSuspension(
  tx: ConnectionTransaction, orgDid: string, actorDid: string, input: SuspensionInput, row?: ConnectorRow,
) {
  const provider = row?.provider ?? input.provider!;
  const memberDid = row?.ownerDid ?? '';
  const slot = row?.slot ?? '';
  const suspendedAt = input.action === 'suspend' ? new Date() : null;
  await tx.insert(orgConnectionSuspensions).values({ orgDid, memberDid, provider, slot, suspendedAt })
    .onConflictDoUpdate({
      target: [orgConnectionSuspensions.orgDid, orgConnectionSuspensions.memberDid, orgConnectionSuspensions.provider, orgConnectionSuspensions.slot],
      set: { suspendedAt },
    });
  if (row) await tx.update(connectors).set({ orgSuspendedAt: suspendedAt, updatedAt: new Date() })
    .where(and(eq(connectors.id, row.id), eq(connectors.orgContextDid, orgDid)));
  const event = {
    id: generateId('oce'), orgDid, memberDid: memberDid || null, provider, connectionId: row?.id ?? null,
    actorDid, action: input.action, reason: input.reason,
  };
  const attestation = await prepareMechanicalAttestation({
    type: 'connector.external-mcp', subjectDid: memberDid || orgDid, contextId: orgDid, contextType: 'org-connections',
    payload: event,
  });
  await tx.insert(attestations).values(attestation);
  await tx.insert(orgConnectionEvents).values({ ...event, attestationId: attestation.id });
}

export function changeOrgConnection(actor: DocumentActor, input: SuspensionInput) {
  return db.transaction(async tx => {
    const orgDid = await requireOrgAdmin(tx, actor);
    let row: ConnectorRow | undefined;
    if (input.connectionId) {
      [row] = await tx.select().from(connectors).where(and(
        eq(connectors.id, input.connectionId), eq(connectors.orgContextDid, orgDid),
      )).limit(1);
      if (!row) throw new OwnershipError('Organization connection not found', 404);
    }
    await recordSuspension(tx, orgDid, actor.actingHumanDid, input, row);
    return { ok: true };
  });
}

/** Called inside the canonical removal transaction; reconnect and removal share the custody snapshot lock. */
export async function suspendRemovedMember(tx: ConnectionTransaction, orgDid: string, memberDid: string, actorDid: string) {
  const lockKey = `external-mcp:${memberDid}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
  const rows = await tx.select().from(connectors).where(and(
    eq(connectors.orgContextDid, orgDid), eq(connectors.ownerDid, memberDid),
  ));
  for (const row of rows) await recordSuspension(tx, orgDid, actorDid, {
    action: 'suspend', reason: 'Organization membership removed', connectionId: row.id,
  }, row);
}

/** Admin metadata allowlist: never return fields, bindings, credentials or provider bodies. */
export function listOrgConnections(actor: DocumentActor) {
  return db.transaction(async tx => {
    const orgDid = await requireOrgAdmin(tx, actor);
    const connections = await tx.select({
      id: connectors.id, memberDid: connectors.ownerDid, provider: connectors.provider,
      slot: connectors.slot, status: connectors.status,
    }).from(connectors).where(eq(connectors.orgContextDid, orgDid));
    const suspensions = await tx.select().from(orgConnectionSuspensions).where(eq(orgConnectionSuspensions.orgDid, orgDid));
    const events = await tx.select().from(orgConnectionEvents).where(eq(orgConnectionEvents.orgDid, orgDid))
      .orderBy(desc(orgConnectionEvents.createdAt)).limit(100);
    return { connections, suspensions, events };
  });
}
