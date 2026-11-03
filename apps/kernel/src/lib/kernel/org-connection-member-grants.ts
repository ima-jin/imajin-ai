import { and, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import {
  db, attestations, connectors, identities, identityMembers, orgConnectionEvents,
  orgConnectionMemberGrants, orgConnectionSuspensions, type ConnectorRow, type OrgConnectionMemberGrant,
} from '@/src/db';
import { prepareMechanicalAttestation } from '@/src/lib/auth/emit-mechanical-attestation';
import { ExternalMcpError, type ConnectionErrorCode } from './external-mcp-policy';
import { generateId } from './id';
import { isLiveConnection, type ConnectionTransaction } from './member-connection-gate';
import { authorizeOrgConnectionAdmin, orgHeldProvider, type OrgConnectionActor } from './org-held-connection-policy';

export interface MemberGrantInput { memberDid: string; reason: string }
export function parseMemberGrantInput(raw: unknown): MemberGrantInput {
  const fail = () => { throw new ExternalMcpError(400, 'Provide memberDid and reason only'); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail();
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some(key => !['memberDid', 'reason'].includes(key))) return fail();
  if (typeof value.memberDid !== 'string' || !/^did:[a-z0-9]+:[^\s]+$/.test(value.memberDid)
    || value.memberDid.length > 256) return fail();
  if (typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 500) return fail();
  return { memberDid: value.memberDid, reason: value.reason.trim() };
}

const denied = (provider: string, code: ConnectionErrorCode = 'org_grant_required') => new ExternalMcpError(403,
  `Active org-connection member grant required for ${provider}. Ask an org admin to grant access on the org's connector card on /auth/connectors while acting as the org`, code);
type GrantReader = Pick<ConnectionTransaction, 'select'>;

async function requireMember(tx: GrantReader, orgDid: string, memberDid: string, provider: string) {
  const [person] = await tx.select().from(identities).where(eq(identities.id, memberDid)).limit(1);
  const [membership] = await tx.select().from(identityMembers).where(and(
    eq(identityMembers.identityDid, orgDid), eq(identityMembers.memberDid, memberDid), isNull(identityMembers.removedAt),
  )).limit(1);
  if (person?.scope !== 'actor' || person.subtype === 'agent' || person.suspendedAt || !membership) throw denied(provider, 'org_membership_required');
}

async function findConnection(tx: GrantReader, orgDid: string, provider: string) {
  const [row] = await tx.select().from(connectors).where(and(
    eq(connectors.ownerDid, orgDid), eq(connectors.provider, orgHeldProvider(provider)), eq(connectors.slot, 'primary'),
  )).limit(1);
  return row;
}

function liveOrgConnection(row: ConnectorRow) {
  return isLiveConnection(row) && row.sealedKeyField && row.loadedByDid && row.loadedAt;
}

/** Prepare signed evidence without querying the transaction client. */
async function prepareGrantChange(
  grant: OrgConnectionMemberGrant, actorDid: string, action: 'granted' | 'grant-revoked', reason: string,
) {
  const event = {
    id: generateId('oce'), orgDid: grant.orgDid, memberDid: grant.memberDid, connectionId: grant.connectionId,
    provider: grant.provider, actorDid, action, reason,
  };
  const attestation = await prepareMechanicalAttestation({
    type: 'connector.org-held', subjectDid: grant.memberDid, contextId: grant.orgDid, contextType: 'org-connections',
    payload: { ...event, grantId: grant.id },
  });
  return { attestation, event: { ...event, attestationId: attestation.id } };
}

/** Immutable evidence commits in the same transaction as every authority change. */
async function recordGrantChange(
  tx: ConnectionTransaction, grant: OrgConnectionMemberGrant, actorDid: string, action: 'granted' | 'grant-revoked', reason: string,
) {
  const evidence = await prepareGrantChange(grant, actorDid, action, reason);
  await tx.insert(attestations).values(evidence.attestation);
  await tx.insert(orgConnectionEvents).values(evidence.event);
}

async function revokeRows(
  tx: ConnectionTransaction, rows: OrgConnectionMemberGrant[], actorDid: string, reason: string,
) {
  if (rows.length === 0) return 0;
  const revoked = await tx.update(orgConnectionMemberGrants)
    .set({ revokedAt: new Date(), revokedByDid: actorDid, revocationReason: reason })
    .where(and(inArray(orgConnectionMemberGrants.id, rows.map(row => row.id)), isNull(orgConnectionMemberGrants.revokedAt)))
    .returning();
  if (revoked.length === 0) return 0;
  const evidence = await Promise.all(revoked.map(row => prepareGrantChange(row, actorDid, 'grant-revoked', reason)));
  await tx.insert(attestations).values(evidence.map(item => item.attestation));
  await tx.insert(orgConnectionEvents).values(evidence.map(item => item.event));
  return revoked.length;
}

/** No custody access. Duplicate grants/revokes are no-ops; regrant creates a fresh row. */
export function changeOrgConnectionMemberGrant(
  actor: OrgConnectionActor, provider: string, input: MemberGrantInput, action: 'grant' | 'revoke',
) {
  return db.transaction(async tx => {
    await authorizeOrgConnectionAdmin(tx, actor, 'update');
    const connection = await findConnection(tx, actor.orgDid, provider);
    if (!connection) throw new ExternalMcpError(404, 'Organization connection not found');
    const rows = await tx.select().from(orgConnectionMemberGrants).where(and(
      eq(orgConnectionMemberGrants.orgDid, actor.orgDid), eq(orgConnectionMemberGrants.memberDid, input.memberDid),
      eq(orgConnectionMemberGrants.connectionId, connection.id), isNull(orgConnectionMemberGrants.revokedAt),
    ));
    if (action === 'revoke') {
      const revoked = await revokeRows(tx, rows, actor.actorDid, input.reason);
      return { changed: revoked > 0 };
    }
    if (!liveOrgConnection(connection)) throw new ExternalMcpError(409, 'Active loaded organization connection required');
    await requireMember(tx, actor.orgDid, input.memberDid, provider);
    if (rows.length > 0) return { changed: false };
    const grant: OrgConnectionMemberGrant = {
      id: generateId('ocg'), orgDid: actor.orgDid, memberDid: input.memberDid, connectionId: connection.id,
      provider, grantedByDid: actor.actorDid, grantedAt: new Date(), revokedAt: null, revokedByDid: null, revocationReason: null,
    };
    await tx.insert(orgConnectionMemberGrants).values(grant);
    await recordGrantChange(tx, grant, actor.actorDid, 'granted', input.reason);
    return { changed: true };
  });
}

/** Called while canonical removal holds the org-row lock; never revoke the shared org key. */
export async function revokeRemovedMemberOrgGrants(
  tx: ConnectionTransaction, orgDid: string, memberDid: string, actorDid: string,
) {
  const rows = await tx.select().from(orgConnectionMemberGrants).where(and(
    eq(orgConnectionMemberGrants.orgDid, orgDid), eq(orgConnectionMemberGrants.memberDid, memberDid),
    isNull(orgConnectionMemberGrants.revokedAt),
  ));
  await revokeRows(tx, rows, actorDid, 'Organization membership removed');
}

/** Active provenance only; revoked history is retained, not listed by default. */
export function listOrgConnectionMemberGrants(actor: OrgConnectionActor, provider: string) {
  return db.transaction(async tx => {
    await authorizeOrgConnectionAdmin(tx, actor);
    return { grants: await tx.select().from(orgConnectionMemberGrants).where(and(
      eq(orgConnectionMemberGrants.orgDid, actor.orgDid), eq(orgConnectionMemberGrants.provider, provider),
      isNull(orgConnectionMemberGrants.revokedAt),
    )) };
  });
}

export interface OrgMemberGrantContext { memberDid: string; orgDid: string; actingDid: string; provider: string }

/**
 * Contract for #3202/#3203: invoke with verified member/acting context on EVERY call, before custody.
 * No unseal and no credential reference in the result. A rejoin never restores a revoked grant.
 * The runtime must also enforce its lane/app scopes and keep subsequent custody server-side.
 */
export async function requireOrgConnectionMemberGrant(context: OrgMemberGrantContext, tx: GrantReader = db) {
  const { memberDid, orgDid, actingDid, provider } = context;
  if (!memberDid || !orgDid || actingDid !== orgDid || memberDid === orgDid) throw denied(provider);
  const [org] = await tx.select().from(identities).where(eq(identities.id, orgDid)).limit(1);
  if (!org || !['business', 'community', 'family'].includes(org.scope) || org.suspendedAt) throw denied(provider);
  await requireMember(tx, orgDid, memberDid, provider);
  const connection = await findConnection(tx, orgDid, provider);
  if (!connection || !liveOrgConnection(connection)) throw denied(provider, 'connection_not_loaded');
  const [grant] = await tx.select().from(orgConnectionMemberGrants).where(and(
    eq(orgConnectionMemberGrants.orgDid, orgDid), eq(orgConnectionMemberGrants.memberDid, memberDid),
    eq(orgConnectionMemberGrants.connectionId, connection.id), eq(orgConnectionMemberGrants.provider, provider),
    isNull(orgConnectionMemberGrants.revokedAt),
  )).limit(1);
  if (!grant) throw denied(provider);
  const [suspension] = await tx.select().from(orgConnectionSuspensions).where(and(
    eq(orgConnectionSuspensions.orgDid, orgDid),
    or(eq(orgConnectionSuspensions.provider, provider), eq(orgConnectionSuspensions.provider, orgHeldProvider(provider))),
    isNotNull(orgConnectionSuspensions.suspendedAt),
    or(eq(orgConnectionSuspensions.memberDid, ''), and(
      eq(orgConnectionSuspensions.memberDid, memberDid),
      or(eq(orgConnectionSuspensions.slot, ''), eq(orgConnectionSuspensions.slot, connection.slot)),
    )),
  )).limit(1);
  if (suspension) throw denied(provider, 'connection_suspended');
  return { grantId: grant.id, orgDid, memberDid, connectionId: connection.id, provider, grantedAt: grant.grantedAt };
}
