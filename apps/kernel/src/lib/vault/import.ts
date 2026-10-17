import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { emitAttestation } from '@imajin/auth';
import { publish } from '@imajin/bus';
import { createLogger } from '@imajin/logger';
import { db, operatorApprovals, vaultDelegationGrants } from '@/src/db';
import { computeApprovalContentHash } from '@/src/lib/notify/operator-approvals';
import type { OperatorApprovalCard } from '@/src/lib/notify/operator-approvals-service';
import { isAppSecretValue } from '@/src/lib/apps/secret-staging';
import { consumeImport, type ImportDetail } from './import-staging';
import { canExecuteImport } from './import-authority';
import { resolveVaultAuthorization, type VaultAuthorization } from './authorization';
import { sealAndGrantStaticSecret, eraseInactiveGrantKeyMaterial, vaultService, type DbExecutor } from './index';
import { getNodeSigningIdentity, isVaultTier1 } from './sealing';
import { IMPORTED_KEY_NAMESPACE, isImportedKeyField, parseVaultFieldName } from './field-grammar';

const log = createLogger('kernel:vault:import');
const DID = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;
const METADATA_KEYS = ['ownerDid', 'consumerDid', 'purpose', 'fingerprint', 'label', 'expiresAt', 'replacesField'];

export function importedKeyField(proposalId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(proposalId)) throw new Error('Invalid import proposal');
  return `${IMPORTED_KEY_NAMESPACE}:${proposalId}`;
}

function rotationProposalId(field: string): string {
  const parsed = parseVaultFieldName(field);
  if (!parsed.ok || parsed.value.namespace !== IMPORTED_KEY_NAMESPACE) throw new Error('Invalid import rotation target');
  return parsed.value.name;
}

export function validImportMetadata(raw: Record<string, unknown>): boolean {
  return typeof raw.ownerDid === 'string' && DID.test(raw.ownerDid)
    && typeof raw.consumerDid === 'string' && DID.test(raw.consumerDid)
    && typeof raw.purpose === 'string' && raw.purpose.trim().length > 0 && raw.purpose.length <= 200
    && (raw.label === null || (typeof raw.label === 'string' && raw.label.length <= 200))
    && (raw.expiresAt === null || (typeof raw.expiresAt === 'string' && Number.isFinite(Date.parse(raw.expiresAt))))
    && (raw.replacesField === null || (typeof raw.replacesField === 'string' && isImportedKeyField(raw.replacesField)));
}

/** Failures never interpolate input, parser exceptions, or provider diagnostics. */
export function validateImportBody(raw: unknown): raw is {
  ownerDid: string; consumerDid: string; purpose: string; secret: string;
  label?: string; expiresAt?: string | null; replacesField?: string;
} {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const body = raw as Record<string, unknown>;
  if (Object.keys(body).some(key => !['ownerDid', 'consumerDid', 'purpose', 'secret', 'label', 'expiresAt', 'replacesField'].includes(key))) return false;
  if (!isAppSecretValue(body.secret)) return false;
  if (!validImportMetadata({ ...body, label: body.label ?? null, expiresAt: body.expiresAt ?? null, replacesField: body.replacesField ?? null })) return false;
  return body.expiresAt == null || Date.parse(body.expiresAt as string) > Date.now();
}

function readDetail(raw: Record<string, unknown> | null): ImportDetail | null {
  if (!raw || Object.keys(raw).some(key => ![...METADATA_KEYS, 'stagingRef'].includes(key))) return null;
  if (!validImportMetadata(raw) || typeof raw.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(raw.fingerprint)) return null;
  if (raw.expiresAt && Date.parse(raw.expiresAt as string) <= Date.now()) return null;
  const detail = { ...raw };
  delete detail.stagingRef;
  return detail as ImportDetail;
}

/** Rotation is restricted to a successfully imported field with the exact same owner, consumer and purpose. */
export async function requireImportRotationTarget(detail: ImportDetail, executor: DbExecutor = db): Promise<void> {
  if (!detail.replacesField) return;
  const [target] = await executor.select({ proposalId: operatorApprovals.proposalId })
    .from(operatorApprovals).where(and(
      eq(operatorApprovals.source, 'vault'), eq(operatorApprovals.kind, 'vault:import'),
      eq(operatorApprovals.status, 'applied'), isNotNull(operatorApprovals.appliedAt),
      eq(operatorApprovals.proposalId, rotationProposalId(detail.replacesField)),
      eq(sql`${operatorApprovals.detail}->>'ownerDid'`, detail.ownerDid),
      eq(sql`${operatorApprovals.detail}->>'consumerDid'`, detail.consumerDid),
      eq(sql`${operatorApprovals.detail}->>'purpose'`, detail.purpose),
    )).limit(1);
  if (!target) throw new Error('Invalid import rotation target');
  const [grant] = await executor.select({ id: vaultDelegationGrants.id }).from(vaultDelegationGrants).where(and(
    eq(vaultDelegationGrants.field, detail.replacesField),
    eq(vaultDelegationGrants.subject, detail.ownerDid),
    eq(vaultDelegationGrants.grantedTo, detail.consumerDid),
    eq(vaultDelegationGrants.purpose, detail.purpose),
    eq(vaultDelegationGrants.status, 'active'),
  )).limit(1);
  if (!grant) throw new Error('Invalid import rotation target');
}

async function revokeImportTarget(detail: ImportDetail, executor: DbExecutor): Promise<void> {
  if (!detail.replacesField) return;
  const revoked = await executor.update(vaultDelegationGrants).set({ status: 'revoked', revokedAt: new Date() })
    .where(and(
      eq(vaultDelegationGrants.field, detail.replacesField),
      eq(vaultDelegationGrants.subject, detail.ownerDid),
      eq(vaultDelegationGrants.status, 'active'),
    )).returning({ id: vaultDelegationGrants.id, field: vaultDelegationGrants.field, keyId: vaultDelegationGrants.keyId });
  if (!revoked.length) throw new Error('Import rotation target no longer active');
  await eraseInactiveGrantKeyMaterial(revoked, executor);
}

function emitImported(detail: ImportDetail, field: string, grantId: string, authorizedBy: VaultAuthorization): void {
  const nodeDid = getNodeSigningIdentity().senderDid;
  const payload = { ...detail, field, grantId, authorizedBy };
  // Diagnostics deliberately omit underlying errors, including errors from event providers.
  void Promise.resolve().then(() => emitAttestation({
    issuer_did: nodeDid, subject_did: detail.ownerDid, type: 'vault.key.imported',
    context_id: authorizedBy.approvalId, context_type: 'vault.import', payload,
  })).catch(() => log.error({ proposalId: authorizedBy.approvalId }, 'Import attestation unavailable'));
  void Promise.resolve().then(() => publish('vault.key.imported', {
    issuer: nodeDid, subject: detail.ownerDid, scope: 'vault',
    payload: { ...payload, context_id: authorizedBy.approvalId, context_type: 'vault.import' },
  })).catch(() => log.error({ proposalId: authorizedBy.approvalId }, 'Import event unavailable'));
}

/** Grant/revoke are atomic database writes; only a unique NEW ciphertext field is persisted last. */
export async function executeImportApproval(card: OperatorApprovalCard): Promise<{ ok: boolean; error?: string }> {
  try {
    const authorization = resolveVaultAuthorization(card);
    const detail = readDetail(card.detail);
    if (!authorization || !detail || card.source !== 'vault' || card.kind !== 'vault:import'
      || card.status !== 'approved' || card.decision?.decision !== 'approve'
      || authorization.operatorDid !== card.operatorDid || isVaultTier1()) throw new Error('Unavailable');
    const expectedHash = computeApprovalContentHash({
      proposalId: card.proposalId, source: card.source, kind: card.kind,
      summary: card.summary, keysTouched: card.keysTouched, detail: card.detail,
    });
    if (expectedHash !== card.contentHash || !(await canExecuteImport(card.operatorDid, detail.ownerDid))) throw new Error('Unavailable');
    const field = importedKeyField(card.proposalId);
    // The existing cross-process single-use claim elects one reader. A failed
    // execution intentionally requires a fresh paste rather than caching bytes.
    const value = await consumeImport(card, detail);
    const grantId = await db.transaction(async tx => {
      // Serializes executor retries and withdrawals on the proposal's existing row.
      const [stored] = await tx.select({ status: operatorApprovals.status, contentHash: operatorApprovals.contentHash })
        .from(operatorApprovals).where(eq(operatorApprovals.proposalId, card.proposalId)).for('update');
      if (!stored || stored.status !== 'approved' || stored.contentHash !== expectedHash) throw new Error('Unavailable');
      if (!(await canExecuteImport(card.operatorDid, detail.ownerDid, tx))) throw new Error('Unavailable');
      await requireImportRotationTarget(detail, tx);
      const sealed = await sealAndGrantStaticSecret(field, value, {
        principalDid: detail.ownerDid, granteeDid: detail.consumerDid, purpose: detail.purpose,
        expiresAt: detail.expiresAt ? new Date(detail.expiresAt) : null, oneTime: false, tx,
      });
      if (!sealed.grantId) throw new Error('Unavailable');
      await revokeImportTarget(detail, tx);
      await tx.update(operatorApprovals).set({ status: 'applied', appliedAt: new Date(), updatedAt: new Date() })
        .where(eq(operatorApprovals.proposalId, card.proposalId));
      await vaultService.set(sealed.entry);
      return sealed.grantId;
    });
    emitImported(detail, field, grantId, authorization);
    return { ok: true };
  } catch {
    log.error({ proposalId: card.proposalId }, 'Vault import execution unavailable');
    return { ok: false, error: 'Vault import execution unavailable; submit a new import proposal' };
  }
}

export interface ImportedKeyCard {
  field: string; ownerDid: string; consumerDid: string; purpose: string; label?: string;
  fingerprint: string; grantId: string | null; provenance: 'imported'; status: string;
  timeline: Array<{ type: string; at: string; alert?: boolean }>;
}

/** Reads metadata only. Neither ciphertext nor wrapped keys are selected. */
export async function listImportedKeyCards(ownerDids: string[]): Promise<ImportedKeyCard[]> {
  if (!ownerDids.length) return [];
  const proposals = await db.select({
    proposalId: operatorApprovals.proposalId, detail: operatorApprovals.detail,
    createdAt: operatorApprovals.createdAt, appliedAt: operatorApprovals.appliedAt,
  }).from(operatorApprovals).where(and(
    eq(operatorApprovals.source, 'vault'), eq(operatorApprovals.kind, 'vault:import'),
    isNotNull(operatorApprovals.appliedAt),
    inArray(sql<string>`${operatorApprovals.detail}->>'ownerDid'`, ownerDids),
  ));
  const fields = proposals.map(row => importedKeyField(row.proposalId));
  if (!fields.length) return [];
  const grants = await db.select({
    id: vaultDelegationGrants.id, field: vaultDelegationGrants.field, subject: vaultDelegationGrants.subject,
    grantedTo: vaultDelegationGrants.grantedTo, status: vaultDelegationGrants.status,
    expiresAt: vaultDelegationGrants.expiresAt, createdAt: vaultDelegationGrants.createdAt,
    revokedAt: vaultDelegationGrants.revokedAt, lastFetchedAt: vaultDelegationGrants.lastFetchedAt,
    ackedAt: vaultDelegationGrants.ackedAt,
  }).from(vaultDelegationGrants).where(and(
    inArray(vaultDelegationGrants.field, fields), inArray(vaultDelegationGrants.subject, ownerDids),
  )).orderBy(desc(vaultDelegationGrants.createdAt));
  return proposals.flatMap(row => {
    const detail = row.detail as ImportDetail;
    if (!row.appliedAt || !detail || !ownerDids.includes(detail.ownerDid)) return [];
    const field = importedKeyField(row.proposalId);
    const candidates = grants.filter(g => g.field === field && g.subject === detail.ownerDid && g.grantedTo === detail.consumerDid);
    const grant = candidates.find(g => g.status === 'active') ?? candidates[0];
    const timeline: ImportedKeyCard['timeline'] = [{ type: 'imported', at: row.createdAt.toISOString() }];
    if (grant) {
      timeline.push({ type: 'granted', at: grant.createdAt.toISOString() });
      if (grant.lastFetchedAt) timeline.push({ type: 'fetched', at: grant.lastFetchedAt.toISOString(), alert: !grant.ackedAt || grant.ackedAt < grant.lastFetchedAt });
      if (grant.ackedAt) timeline.push({ type: 'acked', at: grant.ackedAt.toISOString() });
      if (grant.revokedAt) timeline.push({ type: 'revoked', at: grant.revokedAt.toISOString() });
    }
    const status = grant?.status === 'active' && grant.expiresAt && grant.expiresAt <= new Date() ? 'expired' : grant?.status ?? 'unavailable';
    return [{
      field, ownerDid: detail.ownerDid, consumerDid: detail.consumerDid, purpose: detail.purpose,
      ...(detail.label ? { label: detail.label } : {}), fingerprint: detail.fingerprint,
      grantId: grant?.id ?? null, provenance: 'imported' as const, status,
      timeline: timeline.sort((a, b) => a.at.localeCompare(b.at)),
    }];
  });
}
