/**
 * `POST /usage/api/receipts` write model — receipt upload path for non-API
 * costs (#1951, COGS D3/D4 of #1075).
 *
 * A receipt (hardware, cloud infra, contractor invoice) is a counterparty
 * statement, same class as a provider's cost API — so its confirmed line
 * items land in `usage.billed` (never `usage.incurred`; D5 of #1075: never
 * merge, only reconcile). One receipt writes N rows sharing one
 * `receiptId`, each `source = 'receipt:manual'`, plus ONE binding
 * attestation over the whole receipt.
 *
 * D3 (receipt privacy): the attestation proves the confirmed items sum to
 * the receipt's declared total WITHOUT exposing the raw receipt — the
 * payload carries the structured line items and the evidence asset's
 * content hash, never the asset's bytes.
 *
 * D4 (never auto-attest): this module only ever runs against a caller-
 * confirmed set of line items. The Qwen-assist draft
 * (`lib/usage/billed/receipt-extract.ts`) never calls this — a human
 * confirmation (this call) is the only path that writes or attests.
 *
 * FX (#1950, `packages/money`): a line item not already in USD is converted
 * via a signed `FxSnapshot` — the snapshot is persisted alongside the row
 * (migrations/0127_usage_billed_receipts.sql) and embedded in the receipt
 * attestation payload, so `billedUsd` is never an unproven number.
 */
import { db, usageBilled } from '@/src/db';
import { generateId } from '@/src/lib/kernel/id';
import { getActiveAsset } from '@/src/lib/media/queries';
import { emitMechanicalAttestation } from '@/src/lib/auth/emit-mechanical-attestation';
import { getNodeSigningIdentity } from '@/src/lib/vault/sealing';
import {
  convert,
  getRate,
  signFxSnapshot,
  toDecimalString,
  type SignedFxSnapshot,
} from '@imajin/money';

export interface ReceiptLineInput {
  description: string;
  category: string | null;
  /** Minor units (e.g. cents) in the receipt's own currency. */
  amountMinor: number;
  /** The transaction date for this line item. */
  date: Date;
  vendor: string;
}

export interface ConfirmReceiptInput {
  principalDid: string;
  /** media.assets.id for the uploaded receipt — REQUIRED (D3: every receipt line is bound to its source asset's content hash). */
  assetId: string;
  /** ISO 4217-shaped currency code shared by every line and the receipt total. */
  currency: string;
  /** The receipt's own declared total, in `currency` minor units. */
  receiptTotalMinor: number;
  lines: ReceiptLineInput[];
}

export type ConfirmReceiptError =
  | { error: 'evidence_asset_not_found' }
  | { error: 'evidence_asset_not_owned' }
  | { error: 'empty_lines' }
  | { error: 'sum_mismatch'; expectedMinor: number; actualMinor: number }
  | { error: 'fx_unavailable'; cause: string };

export interface ConfirmedReceiptLine {
  id: string;
  lineNo: number;
  description: string;
  category: string | null;
  vendor: string;
  amountMinor: number;
  currency: string;
  date: string;
  billedUsd: string;
}

export interface ConfirmReceiptResult {
  receiptId: string;
  assetId: string;
  evidenceContentHash: string;
  currency: string;
  receiptTotalMinor: number;
  lines: ConfirmedReceiptLine[];
  attestationId: string | null;
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Resolve one line's USD projection + (when converted) the signed
 * `FxSnapshot` that proves the rate used. Identity (no conversion, no
 * snapshot) for USD lines — nothing to prove when no conversion happened.
 */
async function resolveLineUsd(
  amountMinor: number,
  currency: string,
  date: Date,
): Promise<{ billedUsd: string; snapshot: SignedFxSnapshot | null }> {
  if (currency === 'USD') {
    return { billedUsd: toDecimalString({ amount: amountMinor, currency: 'USD' }), snapshot: null };
  }

  const asOf = toIsoDate(date);
  const rate = await getRate(currency, 'USD', asOf, db);
  const usdMoney = convert({ amount: amountMinor, currency }, rate);
  const signingIdentity = getNodeSigningIdentity();
  const snapshot = await signFxSnapshot(rate, signingIdentity.privateKeyHex);
  return { billedUsd: toDecimalString(usdMoney), snapshot };
}

/**
 * Confirm + persist a receipt's line items, and mint the binding
 * attestation. Returns a typed error (never throws for a caller-fixable
 * condition) when the evidence asset can't be resolved, no lines were
 * given, the lines don't sum to the declared total (D3's sum invariant),
 * or FX resolution failed for a non-USD receipt.
 */
export async function confirmReceiptLines(
  input: ConfirmReceiptInput,
): Promise<ConfirmReceiptResult | ConfirmReceiptError> {
  if (input.lines.length === 0) return { error: 'empty_lines' };

  const asset = await getActiveAsset(input.assetId);
  if (!asset) return { error: 'evidence_asset_not_found' };
  if (asset.ownerDid !== input.principalDid) return { error: 'evidence_asset_not_owned' };

  // D3 sum invariant: the confirmed items must sum to exactly the receipt's
  // declared total, in the receipt's own currency (minor units — integers,
  // never floats) — checked BEFORE anything is written.
  const actualMinor = input.lines.reduce((sum, line) => sum + line.amountMinor, 0);
  if (actualMinor !== input.receiptTotalMinor) {
    return { error: 'sum_mismatch', expectedMinor: input.receiptTotalMinor, actualMinor };
  }

  const receiptId = generateId('receipt');
  const rows: (typeof usageBilled.$inferInsert)[] = [];
  const confirmedLines: ConfirmedReceiptLine[] = [];

  for (const [index, line] of input.lines.entries()) {
    let resolved: { billedUsd: string; snapshot: SignedFxSnapshot | null };
    try {
      resolved = await resolveLineUsd(line.amountMinor, input.currency, line.date);
    } catch (err) {
      return { error: 'fx_unavailable', cause: String(err) };
    }

    const lineNo = index + 1;
    const id = generateId('billed');
    rows.push({
      id,
      principalDid: input.principalDid,
      provider: line.vendor,
      periodStart: line.date,
      periodEnd: line.date,
      granularity: 'manual',
      model: null,
      tokensIn: null,
      tokensOut: null,
      billedUsd: resolved.billedUsd,
      raw: { assetId: input.assetId, assetHash: asset.hash, line: { description: line.description, category: line.category, vendor: line.vendor } },
      source: 'receipt:manual',
      currency: input.currency,
      amountMinor: line.amountMinor,
      category: line.category,
      description: line.description,
      evidenceAssetId: input.assetId,
      evidenceContentHash: asset.hash,
      receiptId,
      lineNo,
      receiptTotalMinor: input.receiptTotalMinor,
      fxRate: resolved.snapshot?.rate ?? null,
      fxSource: resolved.snapshot?.source ?? null,
      fxAsOf: resolved.snapshot?.asOf ?? null,
      fxSignature: resolved.snapshot?.signature ?? null,
    });
    confirmedLines.push({
      id,
      lineNo,
      description: line.description,
      category: line.category,
      vendor: line.vendor,
      amountMinor: line.amountMinor,
      currency: input.currency,
      date: line.date.toISOString(),
      billedUsd: resolved.billedUsd,
    });
  }

  // All-or-nothing: a receipt is one atomic unit, never a partially-written
  // set of lines.
  await db.transaction(async (tx) => {
    await tx.insert(usageBilled).values(rows);
  });

  // ONE attestation over the whole receipt — structured line items + the
  // asset's content hash, NEVER the asset's bytes (D3).
  const attestationId = await emitMechanicalAttestation({
    subjectDid: input.principalDid,
    type: 'usage.billed',
    contextId: receiptId,
    contextType: 'usage.receipt',
    payload: {
      receiptId,
      assetId: input.assetId,
      evidenceContentHash: asset.hash,
      currency: input.currency,
      receiptTotalMinor: input.receiptTotalMinor,
      sumMinor: actualMinor,
      lines: confirmedLines,
    },
  });

  return {
    receiptId,
    assetId: input.assetId,
    evidenceContentHash: asset.hash,
    currency: input.currency,
    receiptTotalMinor: input.receiptTotalMinor,
    lines: confirmedLines,
    attestationId,
  };
}
