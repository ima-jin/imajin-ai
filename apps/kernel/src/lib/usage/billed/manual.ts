/**
 * `POST /usage/api/billed` write model — manual/backfill `usage.billed` line
 * items (#2030, widening #1951 D4 "manual entry v1").
 *
 * Writes ONE `usage.billed` row (never `usage.incurred` — D5: never merge,
 * only reconcile) plus a `usage.billed` attestation on the principal's own
 * DID (`emitMechanicalAttestation`, the same node-signed primitive
 * `usage.incurred`/`usage.rollup` already use) binding the line item, and
 * the evidence asset's content hash when one is given. `period` may be in
 * the past — this is explicitly a backfill path.
 */
import { generateId } from '@/src/lib/kernel/id';
import { db, usageBilled } from '@/src/db';
import { getActiveAsset } from '@/src/lib/media/queries';
import { emitMechanicalAttestation } from '@/src/lib/auth/emit-mechanical-attestation';

export type ManualBilledSource = 'manual' | 'document';

export interface ManualBilledLineInput {
  principalDid: string;
  vendor: string;
  periodStart: Date;
  periodEnd: Date;
  amountMinor: number;
  currency: string;
  category: string | null;
  description: string | null;
  source: ManualBilledSource;
  evidenceAssetId: string | null;
}

export type ManualBilledLineError =
  | { error: 'evidence_asset_not_found' }
  | { error: 'evidence_asset_not_owned' };

export interface ManualBilledLineResult {
  id: string;
  principalDid: string;
  vendor: string;
  periodStart: string;
  periodEnd: string;
  amountMinor: number;
  currency: string;
  category: string | null;
  description: string | null;
  source: ManualBilledSource;
  evidenceAssetId: string | null;
  evidenceContentHash: string | null;
  attestationId: string | null;
}

/**
 * Resolve the evidence asset's content hash when `evidenceAssetId` is
 * given. The asset must be active and owned by the same principal the
 * line item is being recorded against — evidence for someone else's spend
 * is never a valid binding.
 */
async function resolveEvidenceHash(
  evidenceAssetId: string | null,
  principalDid: string,
): Promise<{ hash: string | null } | ManualBilledLineError> {
  if (!evidenceAssetId) return { hash: null };

  const asset = await getActiveAsset(evidenceAssetId);
  if (!asset) return { error: 'evidence_asset_not_found' };
  if (asset.ownerDid !== principalDid) return { error: 'evidence_asset_not_owned' };

  return { hash: asset.hash };
}

function isManualBilledLineError(value: unknown): value is ManualBilledLineError {
  return typeof value === 'object' && value !== null && 'error' in value;
}

/**
 * Insert one manual/backfill `usage.billed` line item and mint its binding
 * attestation. Returns a typed error (never throws) when the referenced
 * evidence asset cannot be resolved — everything else is caller-checked
 * input validation, handled before this is called.
 */
export async function insertManualBilledLine(
  input: ManualBilledLineInput,
): Promise<ManualBilledLineResult | ManualBilledLineError> {
  const evidence = await resolveEvidenceHash(input.evidenceAssetId, input.principalDid);
  if (isManualBilledLineError(evidence)) return evidence;

  const id = generateId('billed');
  // `amountMinor` cents -> `billed_usd` dollars. Exact only because the
  // caller (POST /usage/api/billed's validateBilledBody) has already
  // rejected every `currency` other than 'USD' — writing a non-USD amount
  // in here at face value would be silently wrong by the FX rate (#1950 FX
  // is out of scope, so non-USD is rejected rather than mis-recorded).
  const billedUsd = (input.amountMinor / 100).toFixed(8);

  await db.insert(usageBilled).values({
    id,
    principalDid: input.principalDid,
    provider: input.vendor,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    // Deliberately NOT 'day'/'month' — see migrations/0125's header on why
    // a backfill entry never participates in the by-day reconciliation.
    granularity: 'manual',
    model: null,
    tokensIn: null,
    tokensOut: null,
    billedUsd,
    source: input.source,
    currency: input.currency,
    amountMinor: input.amountMinor,
    category: input.category,
    description: input.description,
    evidenceAssetId: input.evidenceAssetId,
    evidenceContentHash: evidence.hash,
  });

  const attestationId = await emitMechanicalAttestation({
    subjectDid: input.principalDid,
    type: 'usage.billed',
    contextId: id,
    contextType: 'usage.billed',
    payload: {
      billedId: id,
      vendor: input.vendor,
      periodStart: input.periodStart.toISOString(),
      periodEnd: input.periodEnd.toISOString(),
      amountMinor: input.amountMinor,
      currency: input.currency,
      category: input.category,
      description: input.description,
      source: input.source,
      evidenceAssetId: input.evidenceAssetId,
      evidenceContentHash: evidence.hash,
    },
  });

  return {
    id,
    principalDid: input.principalDid,
    vendor: input.vendor,
    periodStart: input.periodStart.toISOString(),
    periodEnd: input.periodEnd.toISOString(),
    amountMinor: input.amountMinor,
    currency: input.currency,
    category: input.category,
    description: input.description,
    source: input.source,
    evidenceAssetId: input.evidenceAssetId,
    evidenceContentHash: evidence.hash,
    attestationId,
  };
}
