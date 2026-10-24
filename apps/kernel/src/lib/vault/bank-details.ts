import { and, eq, inArray, sql } from 'drizzle-orm';
import type { VaultEntry } from '@imajin/vault-core';
import { db, assets, identities, attestations, vaultDelegationGrants, type Asset } from '@/src/db';
import { createAsset } from '@/src/lib/media/create-asset';
import { prepareMechanicalAttestation } from '@/src/lib/auth/emit-mechanical-attestation';
import type { DocumentActor } from '@/src/lib/auth/document-authorization';
import { generateId } from '@/src/lib/kernel/id';
import { sealAndGrantStaticSecret, eraseInactiveGrantKeyMaterial, vaultService } from './index';
import { isVaultTier1 } from './sealing';
import { BANK_DETAILS_NAMESPACE } from './field-grammar';
import {
  BANK_DETAILS_KIND, bankDetailsPublic, bankDetailsSecrets, bankDetailsVisibility,
  bankDetailsDocument, parseBankDetailsInput,
  type BankDetailsRecord, type BankRail,
} from './bank-details-schema';

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function findRecord(ownerDid: string, executor: Pick<typeof db, 'select'> = db): Promise<Asset | undefined> {
  const [asset] = await executor.select().from(assets).where(and(
    eq(assets.ownerDid, ownerDid), eq(assets.status, 'active'),
    sql`${assets.metadata}->>'kind' = ${BANK_DETAILS_KIND}`,
  )).limit(1);
  return asset;
}

/** Serialize all versions and deletes per DID without adding identity columns. */
async function lockOwner(tx: Transaction, ownerDid: string): Promise<void> {
  const [owner] = await tx.select({ id: identities.id }).from(identities)
    .where(eq(identities.id, ownerDid)).for('update');
  if (!owner) throw new Error('Bank details unavailable');
}

function storedRecord(asset: Asset): BankDetailsRecord {
  return (asset.metadata as { bankDetails: BankDetailsRecord }).bankDetails;
}

/**
 * Trusted kernel projection. It does NOT unseal or grant access to secret fields.
 * External callers must enforce each field's visibility before releasing it.
 */
export async function readBankDetails(ownerDid: string) {
  const asset = await findRecord(ownerDid);
  if (!asset) return null;
  const record = storedRecord(asset);
  return {
    recordId: record.recordId, assetId: asset.id, ...record.public,
    visibility: record.visibility,
    hasRail: (rail: BankRail): boolean => record.public.rails.includes(rail),
  };
}

/** Retain every row and revoke every recipient, including future disclosure grants. */
async function retireRecord(tx: Transaction, asset: Asset, actor: DocumentActor, status: 'superseded' | 'deleted') {
  const record = storedRecord(asset);
  const fields = Object.values(record.sealed).map(reference => reference.field);
  const grants = await tx.update(vaultDelegationGrants).set({ status: 'superseded', revokedAt: new Date() })
    .where(and(inArray(vaultDelegationGrants.field, fields), eq(vaultDelegationGrants.status, 'active')))
    .returning({ id: vaultDelegationGrants.id, field: vaultDelegationGrants.field, keyId: vaultDelegationGrants.keyId });
  await eraseInactiveGrantKeyMaterial(grants, tx);
  await tx.update(assets).set({ status, updatedAt: new Date() }).where(eq(assets.id, asset.id));
  const audit = await prepareMechanicalAttestation({
    subjectDid: actor.effectiveDid, type: 'document.revoked',
    contextId: record.recordId, contextType: BANK_DETAILS_KIND,
    payload: { assetId: asset.id, recordId: record.recordId, status, actingHumanDid: actor.actingHumanDid,
      fields, supersededGrantIds: grants.map(grant => grant.id) },
  });
  await tx.insert(attestations).values(audit);
}

/**
 * New immutable version per save: a failed DB commit leaves, at worst, private
 * staged references and inaccessible ciphertext, never a half-replaced live record.
 * Current vault transactions support Tier 0 only; refuse Tier 1 before any write.
 */
export async function saveBankDetails(actor: DocumentActor, raw: unknown) {
  const input = parseBankDetailsInput(raw);
  if (!process.env.AUTH_PRIVATE_KEY || isVaultTier1()) throw new Error('Bank details sealing unavailable');
  return db.transaction(async tx => {
    await lockOwner(tx, actor.effectiveDid);
    const previous = await findRecord(actor.effectiveDid, tx);
    const record: BankDetailsRecord = {
      kind: BANK_DETAILS_KIND, recordId: generateId('bank'), ownerDid: actor.effectiveDid,
      public: bankDetailsPublic(input), visibility: bankDetailsVisibility(input), sealed: {},
    };
    const entries: VaultEntry[] = [];
    // Sequential: persist each field's envelope on the same transaction.
    for (const [name, value] of bankDetailsSecrets(input)) {
      const field = `${BANK_DETAILS_NAMESPACE}:${record.recordId}:${name}:${actor.effectiveDid}`;
      const { entry } = await sealAndGrantStaticSecret(field, value, {
        principalDid: actor.effectiveDid, granteeDid: actor.effectiveDid,
        purpose: BANK_DETAILS_KIND, expiresAt: null, tx,
      });
      record.sealed[name] = { field, keyId: entry.keyId, cid: entry.cid };
      entries.push(entry);
    }
    const { asset } = await createAsset({
      ownerDid: actor.effectiveDid, uploadedBy: actor.actingHumanDid,
      buffer: Buffer.from(bankDetailsDocument(record)), filename: 'bank-details.md',
      mimeType: 'text/markdown', access: 'private', dedup: false, classify: false,
      immutable: true, status: 'processing', tx,
    });
    if (previous) await retireRecord(tx, previous, actor, 'superseded');
    await tx.update(assets).set({
      status: 'active', metadata: { kind: BANK_DETAILS_KIND, bankDetails: record }, updatedAt: new Date(),
    }).where(eq(assets.id, asset.id));
    await tx.insert(attestations).values(await prepareMechanicalAttestation({
      subjectDid: actor.effectiveDid, type: 'document.created',
      contextId: record.recordId, contextType: BANK_DETAILS_KIND,
      payload: { assetId: asset.id, recordId: record.recordId, cid: asset.cid,
        actingHumanDid: actor.actingHumanDid, previousRecordId: previous ? storedRecord(previous).recordId : null,
        sealed: record.sealed },
    }));
    // Last: unique immutable field names mean rollback cannot damage an older version.
    for (const entry of entries) await vaultService.set(entry);
    return { recordId: record.recordId, assetId: asset.id };
  });
}

export async function deleteBankDetails(actor: DocumentActor): Promise<boolean> {
  return db.transaction(async tx => {
    await lockOwner(tx, actor.effectiveDid);
    const asset = await findRecord(actor.effectiveDid, tx);
    if (!asset) return false;
    await retireRecord(tx, asset, actor, 'deleted');
    return true;
  });
}
