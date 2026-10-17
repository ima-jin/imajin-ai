/**
 * Pending operator input is sealed outside proposals. The existing provisioning
 * claim table supplies a durable, cross-process single-use marker, NOT a grant.
 * A failed/expired attempt must be submitted again; plaintext is never cached.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, like } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';
import { db, internalSecretProvisions } from '@/src/db';
import { sealAndStore, loadAndUnseal, deleteFromVault, vaultService } from '@/src/lib/vault';
import { getNodeSigningIdentity, isVaultTier1 } from '@/src/lib/vault/sealing';
import { isAppSecretStagingField } from '@/src/lib/vault/field-grammar';
import type { OperatorApprovalCard } from '@/src/lib/notify/operator-approvals-service';
import { appSecretsKind } from './secrets-kind';

const log = createLogger('kernel:apps:secret-staging');

export interface AppSecretStagingBinding {
  proposalId: string;
  operatorDid: string;
  appDid: string;
  name: string;
  action: 'set' | 'rotate';
}
const STAGING_TTL_MS = 24 * 60 * 60 * 1000;
const REF_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isAppSecretValue(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= 65_536;
}

function location(ref: string) {
  if (!REF_PATTERN.test(ref)) throw new Error('App-secret staging unavailable');
  const purpose = `app-self:staging:${ref}`;
  return { purpose, field: `internal-secret:${purpose}` };
}

function provisionTuple(ref: string) {
  const { purpose, field } = location(ref);
  return and(
    eq(internalSecretProvisions.id, ref),
    eq(internalSecretProvisions.ownerDid, getNodeSigningIdentity().senderDid),
    eq(internalSecretProvisions.purpose, purpose),
    eq(internalSecretProvisions.field, field),
  );
}

/** Retire the single-use claim before erasure so an in-flight reader cannot claim it. */
async function discardStaging(ref: string): Promise<void> {
  await db.delete(internalSecretProvisions).where(provisionTuple(ref));
  // A tombstone alone leaves decryptable v1 history. Only a UUID-derived
  // private staging location may reach this irreversible erasure.
  await vaultService.purge(location(ref).field);
}

type StagingProposal = Pick<OperatorApprovalCard, 'proposalId' | 'operatorDid' | 'source' | 'kind' | 'detail' | 'status'>;

/** Terminal proposals cannot grant input. Never trust a reference without its sealed binding. */
export async function discardAppSecretForProposal(card: StagingProposal): Promise<void> {
  if (card.source !== 'apps' || !['denied', 'withdrawn', 'expired'].includes(card.status)) return;
  if (card.kind !== appSecretsKind('set') && card.kind !== appSecretsKind('rotate')) return;
  const ref = card.detail?.stagingRef;
  if (typeof ref !== 'string') return;
  try {
    const { field } = location(ref);
    const sealed = await loadAndUnseal(field);
    if (sealed) {
      const staged = JSON.parse(sealed) as Record<string, unknown>;
      const binding = {
        proposalId: card.proposalId, operatorDid: card.operatorDid,
        appDid: card.detail?.appDid, name: card.detail?.name,
        action: card.kind === appSecretsKind('set') ? 'set' : 'rotate',
      };
      if (!Object.entries(binding).every(([key, value]) => staged[key] === value)) return;
    }
    await discardStaging(ref);
  } catch {
    // Provider exceptions can contain input. Vault enumeration supplies retries.
    log.error({ proposalId: card.proposalId }, 'App-secret staging cleanup failed');
  }
}

/** Only exact staging tuples are eligible; active credentials are never read or erased. */
async function sweepStagingRow(row: { id: string; purpose: string; field: string }, now: number): Promise<boolean> {
  if (!isAppSecretStagingField(row.field) || !REF_PATTERN.test(row.id)) return false;
  const expected = location(row.id);
  if (row.field !== expected.field || row.purpose !== expected.purpose) return false;
  const sealed = await loadAndUnseal(row.field);
  if (sealed) {
    const staged = JSON.parse(sealed) as Record<string, unknown>;
    if (typeof staged.expiresAt !== 'number' || !Number.isFinite(staged.expiresAt) || staged.expiresAt > now) return false;
  }
  await discardStaging(row.id);
  return true;
}

/** Called by the existing hourly vault cron. Counts and diagnostics contain no values. */
export async function sweepExpiredAppSecretStaging(now: number = Date.now()): Promise<number> {
  const rows = await db.select({
    id: internalSecretProvisions.id, purpose: internalSecretProvisions.purpose, field: internalSecretProvisions.field,
  }).from(internalSecretProvisions).where(and(
    eq(internalSecretProvisions.ownerDid, getNodeSigningIdentity().senderDid),
    like(internalSecretProvisions.field, 'internal-secret:app-self:staging:%'),
  ));
  const candidates = new Map(rows.map(row => [row.field, row]));
  // Consumption deletes its claim before tombstoning; staging seals before
  // inserting a marker. Discover those crash windows from vault names too.
  const vault = await vaultService.loadVault();
  for (const { field } of vault.entries) {
    if (!isAppSecretStagingField(field) || candidates.has(field)) continue;
    const id = field.slice('internal-secret:app-self:staging:'.length);
    if (!REF_PATTERN.test(id)) continue;
    const { purpose } = location(id);
    candidates.set(field, { id, purpose, field });
  }
  let swept = 0;
  let failed = false;
  for (const row of candidates.values()) {
    try {
      if (await sweepStagingRow(row, now)) swept++;
    } catch {
      failed = true;
      log.error({ field: row.field }, 'App-secret staging sweep failed');
    }
  }
  if (failed) throw new Error('App-secret staging sweep incomplete');
  return swept;
}
export async function stageAppSecret(binding: AppSecretStagingBinding, value: string): Promise<string> {
  try {
    if (isVaultTier1() || !isAppSecretValue(value)) throw new Error('Unavailable');
    const ref = randomUUID();
    const { purpose, field } = location(ref);
    await sealAndStore(field, JSON.stringify({ ...binding, value, expiresAt: Date.now() + STAGING_TTL_MS }));
    await db.insert(internalSecretProvisions).values({
      id: ref, ownerDid: getNodeSigningIdentity().senderDid, purpose, field,
    });
    return ref;
  } catch {
    throw new Error('App-secret staging unavailable');
  }
}

export async function consumeAppSecret(ref: string, binding: AppSecretStagingBinding): Promise<string> {
  try {
    const { purpose, field } = location(ref);
    const sealed = await loadAndUnseal(field);
    if (!sealed) throw new Error('Unavailable');
    const staged = JSON.parse(sealed) as Record<string, unknown>;
    if (!Object.entries(binding).every(([key, value]) => staged[key] === value)
      || typeof staged.expiresAt !== 'number' || staged.expiresAt <= Date.now()
      || !isAppSecretValue(staged.value)) throw new Error('Unavailable');
    // DELETE RETURNING elects exactly one executor, including across processes.
    const claimed = await db.delete(internalSecretProvisions).where(and(
      eq(internalSecretProvisions.id, ref),
      eq(internalSecretProvisions.ownerDid, getNodeSigningIdentity().senderDid),
      eq(internalSecretProvisions.purpose, purpose),
      eq(internalSecretProvisions.field, field),
    )).returning({ id: internalSecretProvisions.id });
    if (claimed.length !== 1) throw new Error('Unavailable');
    await deleteFromVault(field);
    return staged.value;
  } catch {
    throw new Error('App-secret staging unavailable');
  }
}
