import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { canonicalize, crypto as authCrypto } from '@imajin/auth';
import { db, identities, identityMembers, storedKeys, operatorApprovals, vaultDelegationGrants, attestations } from '@/src/db';
import { decryptPrivateKey } from '@/src/lib/auth/crypto';
import { prepareMechanicalAttestation } from '@/src/lib/auth/emit-mechanical-attestation';
import { getNodeDidFromConfig } from '@/src/lib/kernel/node-identity';
import { computeApprovalContentHash, getOperatorDid, toWireContentHash, type ContentHashFields } from '@/src/lib/notify/operator-approvals';
import { verifyOperatorCountersignature } from '@/src/lib/notify/operator-countersign';
import type { OperatorApprovalCard } from '@/src/lib/notify/operator-approvals-service';
import { canExecuteImport } from './import-authority';
import { resolveVaultAuthorization } from './authorization';
import { sealAndGrantStaticSecret, revokeStaticSecretGrant, vaultService, type DbExecutor } from './index';
import { getNodeSigningIdentity, isVaultTier1 } from './sealing';
import { GROUP_KEY_NAMESPACE, isGroupKeyField } from './field-grammar';

export const GROUP_CUSTODY_KIND = 'vault:custody-group-key';
export const GROUP_REVOKE_KIND = 'vault:revoke-group-key';
const FAILURE = 'Group key custody unavailable';

export interface GroupKeyDetail {
  [key: string]: unknown;
  groupDid: string;
  nodeDid: string;
  purpose: string;
}

/** No credential, arbitrary metadata, expiry, or caller-selected consumer is accepted. */
export function readGroupKeyDetail(raw: unknown): GroupKeyDetail | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some(key => !['groupDid', 'nodeDid', 'purpose'].includes(key))) return null;
  const did = /^did:imajin:[A-Za-z0-9]+$/;
  if (typeof value.groupDid !== 'string' || !did.test(value.groupDid)
    || typeof value.nodeDid !== 'string' || !did.test(value.nodeDid)
    || typeof value.purpose !== 'string' || !/^[a-z][a-z0-9._-]{0,199}$/.test(value.purpose)) return null;
  return { groupDid: value.groupDid, nodeDid: value.nodeDid, purpose: value.purpose };
}

export function groupKeyField(proposalId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(proposalId)) throw new Error(FAILURE);
  return `${GROUP_KEY_NAMESPACE}:${proposalId}`;
}

/** Proposal-time checks never select ciphertext. Execution repeats them under locks. */
export async function authorizeGroupKey(operatorDid: string, detail: GroupKeyDetail, executor: DbExecutor = db): Promise<void> {
  if (isVaultTier1() || operatorDid !== await getOperatorDid()
    || detail.nodeDid !== await getNodeDidFromConfig()
    || detail.nodeDid !== getNodeSigningIdentity().senderDid
    || !(await canExecuteImport(operatorDid, detail.groupDid, executor))) throw new Error(FAILURE);
  const [group] = await executor.select({ scope: identities.scope, suspendedAt: identities.suspendedAt })
    .from(identities).where(eq(identities.id, detail.groupDid)).limit(1);
  if (!group || !['business', 'community', 'family'].includes(group.scope) || group.suspendedAt) throw new Error(FAILURE);
}

async function verifyCard(card: OperatorApprovalCard): Promise<GroupKeyDetail> {
  const detail = readGroupKeyDetail(card.detail);
  const authorization = resolveVaultAuthorization(card);
  if (!detail || !authorization || card.source !== 'vault'
    || ![GROUP_CUSTODY_KIND, GROUP_REVOKE_KIND].includes(card.kind)
    || card.status !== 'approved' || card.decision?.decision !== 'approve'
    || card.decision.decidedBy !== card.operatorDid || !card.decision.operatorSignature
    || card.decision.contentHash !== toWireContentHash(card.contentHash!)) throw new Error(FAILURE);
  if (custodyContentHash(card) !== card.contentHash) throw new Error(FAILURE);
  const checked = await verifyOperatorCountersignature(card.operatorDid, {
    contentHash: card.contentHash!, decision: 'approve', decidedAt: card.decision.decidedAt,
    ...(card.decision.mode ? { mode: card.decision.mode } : {}),
  }, card.decision.operatorSignature);
  if (!checked.ok) throw new Error(FAILURE);
  return detail;
}

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
function custodyContentHash(fields: ContentHashFields): string {
  const { proposalId, source, kind, summary, keysTouched, detail } = fields;
  return computeApprovalContentHash({ proposalId, source, kind, summary, keysTouched, detail });
}

async function lockAuthority(tx: Transaction, card: OperatorApprovalCard, detail: GroupKeyDetail) {
  const [proposal] = await tx.select().from(operatorApprovals)
    .where(eq(operatorApprovals.proposalId, card.proposalId)).for('update');
  if (proposal?.status !== 'approved' || proposal.contentHash !== card.contentHash
    || proposal.operatorDid !== card.operatorDid || proposal.kind !== card.kind
    || custodyContentHash({ ...proposal, keysTouched: proposal.keysTouched ?? [] }) !== card.contentHash
    || canonicalize((proposal.decision as { payload?: unknown } | null)?.payload ?? null) !== canonicalize(card.decision)) throw new Error(FAILURE);
  const [group] = await tx.select().from(identities).where(eq(identities.id, detail.groupDid)).for('update');
  // Lock membership against concurrent role removal while the action commits.
  await tx.select({ memberDid: identityMembers.memberDid }).from(identityMembers)
    .where(and(eq(identityMembers.identityDid, detail.groupDid), eq(identityMembers.memberDid, card.operatorDid))).for('share');
  await authorizeGroupKey(card.operatorDid, detail, tx);
  return group;
}

function purposeWhere(detail: GroupKeyDetail) {
  return and(
    eq(vaultDelegationGrants.subject, detail.groupDid),
    eq(vaultDelegationGrants.grantedTo, detail.nodeDid),
    eq(vaultDelegationGrants.purpose, detail.purpose),
    eq(vaultDelegationGrants.status, 'active'),
    or(isNull(vaultDelegationGrants.expiresAt), gt(vaultDelegationGrants.expiresAt, new Date())),
  );
}

async function sealGroupKey(tx: Transaction, card: OperatorApprovalCard, detail: GroupKeyDetail, publicKey: string) {
  // Any active purpose grant, even on another field, would make purpose fetch ambiguous.
  const existing = await tx.select({ id: vaultDelegationGrants.id }).from(vaultDelegationGrants)
    .where(purposeWhere(detail)).limit(1);
  if (existing.length) throw new Error(FAILURE);
  const [stored] = await tx.select().from(storedKeys).where(eq(storedKeys.did, detail.groupDid)).for('update');
  if (!stored) throw new Error(FAILURE);
  const seed = await decryptPrivateKey(stored);
  if (authCrypto.getPublicKey(seed).toLowerCase() !== publicKey.toLowerCase()) throw new Error(FAILURE);
  const field = groupKeyField(card.proposalId);
  const sealed = await sealAndGrantStaticSecret(field, seed, {
    principalDid: detail.groupDid, granteeDid: detail.nodeDid, purpose: detail.purpose,
    oneTime: false, expiresAt: null, tx,
  });
  if (!sealed.grantId) throw new Error(FAILURE);
  await tx.update(storedKeys).set({ lastUsedAt: new Date() }).where(eq(storedKeys.id, stored.id));
  return { field, grantId: sealed.grantId, entry: sealed.entry };
}

async function revokeGroupKey(tx: Transaction, detail: GroupKeyDetail) {
  const grants = await tx.select({ id: vaultDelegationGrants.id, field: vaultDelegationGrants.field })
    .from(vaultDelegationGrants).where(purposeWhere(detail)).limit(2);
  if (grants.length !== 1 || !isGroupKeyField(grants[0].field)) throw new Error(FAILURE);
  if (!await revokeStaticSecretGrant(grants[0].field, detail.nodeDid, tx)) throw new Error(FAILURE);
  return { field: grants[0].field, grantId: grants[0].id, entry: null };
}

/** Secret-bearing failures are contained here, before the generic bridge can log an error. */
export async function executeGroupKeyApproval(card: OperatorApprovalCard): Promise<{ ok: boolean; error?: string }> {
  try {
    const detail = await verifyCard(card);
    await db.transaction(async tx => {
      const group = await lockAuthority(tx, card, detail);
      const result = card.kind === GROUP_CUSTODY_KIND
        ? await sealGroupKey(tx, card, detail, group.publicKey)
        : await revokeGroupKey(tx, detail);
      const audit = await prepareMechanicalAttestation({
        subjectDid: detail.groupDid, type: card.kind === GROUP_CUSTODY_KIND ? 'vault.key.imported' : 'vault.key.revoked',
        contextId: card.proposalId, contextType: 'vault.group-key',
        payload: { ...detail, field: result.field, grantId: result.grantId, action: card.kind, authorizedBy: resolveVaultAuthorization(card) },
      });
      await tx.insert(attestations).values(audit);
      await tx.update(operatorApprovals).set({ status: 'applied', appliedAt: new Date(), updatedAt: new Date() })
        .where(eq(operatorApprovals.proposalId, card.proposalId));
      // Unique immutable field: a failed DB commit can leave only inaccessible ciphertext.
      if (result.entry) await vaultService.set(result.entry);
    });
    return { ok: true };
  } catch {
    return { ok: false, error: FAILURE };
  }
}
