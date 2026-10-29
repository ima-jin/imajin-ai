import { and, eq, isNotNull, isNull, like, sql } from 'drizzle-orm';
import { db, attestations, connectors, identities, identityMembers, type ConnectorRow } from '@/src/db';
import { prepareMechanicalAttestation } from '@/src/lib/auth/emit-mechanical-attestation';
import { deleteFromVault, revokeStaticSecretGrant, sealAndGrantStaticSecret, vaultService } from '@/src/lib/vault';
import { EXTERNAL_MCP_NAMESPACE } from '@/src/lib/vault/field-grammar';
import { getNodeSigningIdentity, isVaultTier1 } from '@/src/lib/vault/sealing';
import { connectorRegistryId } from './connector-registry-store';
import { getConnector } from './connector-registry';
import { connectInput, ExternalMcpError } from './external-mcp-policy';
import { generateId } from './id';

/** Not a catalogue provider: existing provider lifecycle/resolution cannot select it. */
const ORG_HELD_PREFIX = 'org-held-';
export const orgHeldProvider = (provider: string) => `${ORG_HELD_PREFIX}${provider}`;
export interface OrgConnectionActor { orgDid: string; actorDid: string }
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
const refused = () => new ExternalMcpError(403, 'Active organization owner or admin required');

/** Recheck live authority inside the lifecycle transaction, not the cached session role. */
async function authorize(tx: Transaction, actor: OrgConnectionActor) {
  const [org] = await tx.select().from(identities).where(eq(identities.id, actor.orgDid)).for('share');
  const [person] = await tx.select().from(identities).where(eq(identities.id, actor.actorDid)).for('share');
  const [membership] = await tx.select().from(identityMembers).where(and(
    eq(identityMembers.identityDid, actor.orgDid), eq(identityMembers.memberDid, actor.actorDid),
    isNull(identityMembers.removedAt),
  )).for('share');
  if (!org || !['business', 'community', 'family'].includes(org.scope) || org.suspendedAt
    || !person || person.scope !== 'actor' || person.subtype === 'agent' || person.suspendedAt
    || !membership || !['owner', 'admin'].includes(membership.role)
    || (membership.allowedServices !== null && !membership.allowedServices.includes('connections'))) throw refused();
}

function selection(orgDid: string, provider?: string) {
  return and(eq(connectors.ownerDid, orgDid), eq(connectors.slot, 'primary'),
    provider === undefined ? like(connectors.provider, `${ORG_HELD_PREFIX}%`) : eq(connectors.provider, orgHeldProvider(provider)));
}
function metadata(row: ConnectorRow) {
  return { provider: row.provider.slice(ORG_HELD_PREFIX.length), loadedByDid: row.loadedByDid, loadedAt: row.loadedAt, status: 'loaded' as const };
}
function providerEntry(provider: string) {
  const entry = getConnector(provider);
  if (!entry || !['static-secret', 'token-paste'].includes(entry.ingestionPattern) || entry.backendPending) {
    throw new ExternalMcpError(400, 'Unsupported service-key provider');
  }
  return entry;
}
async function audit(tx: Transaction, actor: OrgConnectionActor, provider: string, action: 'loaded' | 'replaced' | 'revoked') {
  await tx.insert(attestations).values(await prepareMechanicalAttestation({
    subjectDid: actor.orgDid, type: 'connector.org-held', contextId: actor.orgDid, contextType: 'org-held-connection',
    payload: { orgDid: actor.orgDid, actorDid: actor.actorDid, provider, action },
  }));
}
async function locked<T>(actor: OrgConnectionActor, work: (tx: Transaction) => Promise<T>) {
  return db.transaction(async tx => {
    const key = `org-held-connection:${actor.orgDid}`;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    await authorize(tx, actor);
    return work(tx);
  });
}

/** Only an allowlisted projection leaves the service; reads never unseal. */
export function readOrgHeldConnections(actor: OrgConnectionActor, provider?: string) {
  return locked(actor, async tx => {
    const rows = await tx.select().from(connectors)
      .where(and(selection(actor.orgDid, provider), eq(connectors.status, 'active'),
        isNotNull(connectors.sealedKeyField), isNotNull(connectors.loadedByDid), isNotNull(connectors.loadedAt)))
      .orderBy(connectors.provider);
    if (provider !== undefined) {
      if (!rows[0]) throw new ExternalMcpError(404, 'No loaded organization connection');
      return metadata(rows[0]);
    }
    return { connections: rows.map(metadata) };
  });
}

export function loadOrgHeldConnection(actor: OrgConnectionActor, provider: string, raw: unknown) {
  const parsed = connectInput.omit({ orgContextDid: true }).safeParse(raw);
  if (!parsed.success) throw new ExternalMcpError(400, 'Invalid service-key input');
  const entry = providerEntry(provider);
  const { secret } = parsed.data;
  // Metadata cannot become a credential echo through a caller-selected provider/DID.
  if (JSON.stringify([actor, provider, 'loaded', entry.channel]).includes(secret)) {
    throw new ExternalMcpError(400, 'Invalid connection metadata');
  }
  if (isVaultTier1()) throw new ExternalMcpError(409, 'Organization connections require kernel vault custody');
  return locked(actor, async tx => {
    const [previous] = await tx.select().from(connectors).where(selection(actor.orgDid, provider));
    if (previous?.status === 'removed') throw new ExternalMcpError(409, 'Organization connection unavailable');
    const node = getNodeSigningIdentity();
    // Reuse the private-custody namespace: generic fetch, export and renewal deny it.
    const field = `${EXTERNAL_MCP_NAMESPACE}:${generateId('org')}:${actor.orgDid}`;
    const sealed = await sealAndGrantStaticSecret(field, secret, {
      principalDid: actor.orgDid, granteeDid: node.senderDid, purpose: `connectors:org-held:${provider}`, tx,
    });
    if (previous?.sealedKeyField) await revokeStaticSecretGrant(previous.sealedKeyField, node.senderDid, tx);
    const loadedAt = new Date();
    const [row] = await tx.insert(connectors).values({
      id: connectorRegistryId(actor.orgDid, orgHeldProvider(provider), 'primary'),
      ownerDid: actor.orgDid, provider: orgHeldProvider(provider), slot: 'primary', channel: entry.channel,
      connectorDid: node.senderDid, sealedKeyField: field, loadedByDid: actor.actorDid, loadedAt,
      status: 'active',
    }).onConflictDoUpdate({
      target: [connectors.ownerDid, connectors.provider, connectors.slot],
      set: { sealedKeyField: field, connectorDid: node.senderDid, loadedByDid: actor.actorDid, loadedAt,
        status: 'active', revokedAt: null, updatedAt: loadedAt },
    }).returning();
    await audit(tx, actor, provider, previous?.status === 'active' ? 'replaced' : 'loaded');
    await vaultService.set(sealed.entry);
    if (previous?.sealedKeyField) await deleteFromVault(previous.sealedKeyField);
    return metadata(row);
  });
}

/** Retain the row and signed vault history; repeated removal is a no-op. */
export function revokeOrgHeldConnection(actor: OrgConnectionActor, provider: string) {
  return locked(actor, async tx => {
    const [row] = await tx.select().from(connectors).where(selection(actor.orgDid, provider));
    if (!row?.sealedKeyField || row.status !== 'active') return { revoked: true };
    await revokeStaticSecretGrant(row.sealedKeyField, getNodeSigningIdentity().senderDid, tx);
    await tx.update(connectors).set({ status: 'revoked', revokedAt: new Date(), updatedAt: new Date() })
      .where(eq(connectors.id, row.id));
    await audit(tx, actor, provider, 'revoked');
    await deleteFromVault(row.sealedKeyField);
    return { revoked: true };
  });
}
