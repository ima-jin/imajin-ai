import { and, eq, sql } from 'drizzle-orm';
import { canonicalize, crypto as authCrypto, verifySync } from '@imajin/auth';
import { db, attestations, connectors, operatorApprovals, vaultDelegationGrants, type VaultDelegationGrant } from '@/src/db';
import { prepareMechanicalAttestation } from '@/src/lib/auth/emit-mechanical-attestation';
import { authorizeOrgConnectionAdmin, orgHeldProvider, type OrgConnectionActor } from '@/src/lib/kernel/org-held-connection-policy';
import { getConnector } from '@/src/lib/kernel/connector-registry';
import { computeApprovalContentHash, toWireContentHash, type ContentHashFields } from '@/src/lib/notify/operator-approvals';
import type { OperatorApprovalCard } from '@/src/lib/notify/operator-approvals-service';
import { verifyOperatorCountersignature } from '@/src/lib/notify/operator-countersign';
import { canonicalizeGrantPayload, vaultService } from './index';
import { isExternalMcpField } from './field-grammar';
import { getNodeSigningIdentity, getNodeXPublicKey, getOwnerXPublicKey, isVaultTier1 } from './sealing';
import { resolveVaultAuthorization } from './authorization';
import { isImportHuman } from './import-authority';

export const ORG_HELD_RENEWAL_KIND = 'vault:renew-org-held-key';
const FAILURE = 'Organization key renewal unavailable';
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface OrgHeldRenewalInput {
  orgDid: string;
  provider: string;
  expiresAt: string;
}
interface RenewalDetail extends OrgHeldRenewalInput {
  [key: string]: unknown;
  connectionId: string;
  grantId: string;
  field: string;
  entryCid: string;
  previousExpiresAt: string;
}

function futureDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && Date.parse(value) > Date.now();
}

/** No key, grantee, purpose, or custody reference can be supplied by the HTTP caller. */
export function readOrgHeldRenewalInput(raw: unknown): OrgHeldRenewalInput | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some(key => !['orgDid', 'provider', 'expiresAt'].includes(key))) return null;
  if (typeof value.orgDid !== 'string' || !/^did:imajin:[A-Za-z0-9]+$/.test(value.orgDid)
    || typeof value.provider !== 'string' || !futureDate(value.expiresAt)) return null;
  const provider = getConnector(value.provider);
  if (!provider || provider.backendPending || !['static-secret', 'token-paste'].includes(provider.ingestionPattern)) return null;
  return { orgDid: value.orgDid, provider: value.provider, expiresAt: new Date(value.expiresAt).toISOString() };
}

function readDetail(raw: Record<string, unknown> | null): RenewalDetail | null {
  if (!raw || Object.keys(raw).some(key => ![
    'orgDid', 'provider', 'expiresAt', 'connectionId', 'grantId', 'field', 'entryCid', 'previousExpiresAt',
  ].includes(key))) return null;
  const input = readOrgHeldRenewalInput({ orgDid: raw.orgDid, provider: raw.provider, expiresAt: raw.expiresAt });
  if (!input || !['connectionId', 'grantId', 'field', 'entryCid', 'previousExpiresAt']
    .every(key => typeof raw[key] === 'string' && (raw[key] as string).length > 0)) return null;
  return { ...raw, ...input } as RenewalDetail;
}

async function lockOrg(tx: Transaction, actor: OrgConnectionActor) {
  const key = `org-held-connection:${actor.orgDid}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
  await authorizeOrgConnectionAdmin(tx, actor);
  if (!process.env.AUTH_PRIVATE_KEY || isVaultTier1() || !await isImportHuman(actor.actorDid, tx)) throw new Error(FAILURE);
}

function requireRenewableGrant(grant: VaultDelegationGrant | undefined, input: OrgHeldRenewalInput) {
  const node = getNodeSigningIdentity();
  // Never revive revoked/swept custody or change consumers. Renew before erasure.
  if (!grant?.expiresAt || grant.revokedAt || !futureDate(input.expiresAt) || Date.parse(input.expiresAt) <= grant.expiresAt.getTime()
    || grant.oneTime || grant.purpose !== `connectors:org-held:${input.provider}`
    || !grant.wrappedKey || !grant.wrappedNonce
    || grant.ownerEdPub !== node.senderPubkey || grant.recipientXPub !== getNodeXPublicKey()
    || grant.ownerXPub !== getOwnerXPublicKey()
    || !verifySync(grant.ownerSignature, canonicalizeGrantPayload(grant), node.senderPubkey)) throw new Error(FAILURE);
  return grant;
}

/** Resolves the existing grant under the same lock as load/replace, revoke and inference. */
async function renewalTarget(tx: Transaction, input: OrgHeldRenewalInput) {
  const [connection] = await tx.select().from(connectors).where(and(
    eq(connectors.ownerDid, input.orgDid), eq(connectors.provider, orgHeldProvider(input.provider)),
    eq(connectors.slot, 'primary'), eq(connectors.status, 'active'),
  )).for('update');
  if (!connection?.sealedKeyField || !isExternalMcpField(connection.sealedKeyField)
    || connection.orgSuspendedAt || connection.revokedAt
    || (connection.expiresAt && connection.expiresAt <= new Date())) throw new Error(FAILURE);
  const node = getNodeSigningIdentity();
  const [current] = await tx.select().from(vaultDelegationGrants).where(and(
    eq(vaultDelegationGrants.field, connection.sealedKeyField), eq(vaultDelegationGrants.subject, input.orgDid),
    eq(vaultDelegationGrants.grantedTo, node.senderDid), eq(vaultDelegationGrants.status, 'active'),
  )).for('update');
  const grant = requireRenewableGrant(current, input);
  const entry = await vaultService.get(connection.sealedKeyField);
  if (!entry || entry.deleted || entry.custodyScheme !== 'delegation-grant'
    || entry.senderPubkey !== node.senderPubkey || entry.keyId !== grant.keyId) throw new Error(FAILURE);
  return { connection, grant, entry, node };
}

export function prepareOrgHeldRenewal(actor: OrgConnectionActor, input: OrgHeldRenewalInput): Promise<RenewalDetail> {
  return db.transaction(async tx => {
    await lockOrg(tx, actor);
    const { connection, grant, entry } = await renewalTarget(tx, input);
    return { ...input, connectionId: connection.id, grantId: grant.id, field: grant.field,
      entryCid: entry.cid, previousExpiresAt: grant.expiresAt!.toISOString() };
  });
}

function contentHash(fields: ContentHashFields) {
  const { proposalId, source, kind, summary, keysTouched, detail } = fields;
  return computeApprovalContentHash({ proposalId, source, kind, summary, keysTouched, detail });
}

async function verifyCard(card: OperatorApprovalCard) {
  const detail = readDetail(card.detail);
  if (!detail || card.source !== 'vault' || card.kind !== ORG_HELD_RENEWAL_KIND
    || card.status !== 'approved' || card.decision?.decision !== 'approve'
    || card.decision.decidedBy !== card.operatorDid || !card.decision.operatorSignature
    || !resolveVaultAuthorization(card) || contentHash(card) !== card.contentHash
    || card.decision.contentHash !== toWireContentHash(card.contentHash!)) throw new Error(FAILURE);
  const checked = await verifyOperatorCountersignature(card.operatorDid, {
    contentHash: card.contentHash!, decision: 'approve', decidedAt: card.decision.decidedAt,
    ...(card.decision.mode ? { mode: card.decision.mode } : {}),
  }, card.decision.operatorSignature);
  if (!checked.ok) throw new Error(FAILURE);
  return detail;
}

/** Re-sign expiry only: no unwrap, unseal, seal, generation, entry write, or material copy. */
export async function executeOrgHeldRenewal(card: OperatorApprovalCard): Promise<{ ok: boolean; error?: string }> {
  try {
    const detail = await verifyCard(card);
    await db.transaction(async tx => {
      const [proposal] = await tx.select().from(operatorApprovals)
        .where(eq(operatorApprovals.proposalId, card.proposalId)).for('update');
      if (proposal?.status !== 'approved' || proposal.operatorDid !== card.operatorDid
        || proposal.contentHash !== card.contentHash || contentHash({ ...proposal, keysTouched: proposal.keysTouched ?? [] }) !== card.contentHash
        || canonicalize((proposal.decision as { payload?: unknown } | null)?.payload ?? null) !== canonicalize(card.decision)) throw new Error(FAILURE);
      await lockOrg(tx, { orgDid: detail.orgDid, actorDid: card.operatorDid });
      const { connection, grant, entry, node } = await renewalTarget(tx, detail);
      if (connection.id !== detail.connectionId || grant.id !== detail.grantId || grant.field !== detail.field
        || entry.cid !== detail.entryCid || grant.expiresAt!.toISOString() !== detail.previousExpiresAt) throw new Error(FAILURE);
      const expiresAt = new Date(detail.expiresAt);
      const ownerSignature = authCrypto.signSync(canonicalizeGrantPayload({ ...grant, expiresAt }), node.privateKeyHex);
      await tx.update(vaultDelegationGrants).set({ expiresAt, ownerSignature })
        .where(eq(vaultDelegationGrants.id, grant.id));
      await tx.insert(attestations).values(await prepareMechanicalAttestation({
        subjectDid: detail.orgDid, type: 'vault.key.renewed', contextId: card.proposalId, contextType: 'vault.org-held-renewal',
        payload: { ...detail, authorizedBy: resolveVaultAuthorization(card) },
      }));
      await tx.update(operatorApprovals).set({ status: 'applied', appliedAt: new Date(), updatedAt: new Date() })
        .where(eq(operatorApprovals.proposalId, card.proposalId));
    });
    return { ok: true };
  } catch {
    return { ok: false, error: FAILURE };
  }
}
