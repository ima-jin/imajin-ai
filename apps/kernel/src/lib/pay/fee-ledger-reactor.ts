import { createHash } from 'node:crypto';
import { getClient } from '@imajin/db';
import { registerReactor, type ReactorHandler, type FeeReceiptPayload } from '@imajin/bus';
import { db, feeLedger, transactions } from '@/src/db';
import { serializeLoopEvent, type LoopEventJson, type RawLoopEventRow } from '../loops/serialize';
import { verifyStoredLoopReceipt } from '../loops/verify-stored-receipt';
import { isFeeEventType, validateFeeReceipt } from './fee-receipt-payload';

export function feeLedgerRowId(key: string): string {
  return `fl_${createHash('sha256').update(key).digest('hex')}`;
}

export async function loadFeeReceipt(id: string): Promise<LoopEventJson> {
  const sql = getClient();
  const [row] = await sql`SELECT * FROM kernel.loop_events WHERE id = ${id}`;
  if (!row) throw new Error('Fee receipt is not persisted');
  return serializeLoopEvent(row as unknown as RawLoopEventRow);
}

/** Only stored, re-verified facts may materialize rows. Rebuilds never move money. */
export const feeLedgerReactor: ReactorHandler = async event => {
  if (!isFeeEventType(event.type) || !event.id) throw new Error('Expected a persisted fee receipt');
  const receipt = await loadFeeReceipt(event.id);
  const verification = await verifyStoredLoopReceipt(receipt);
  if (!verification.ok || receipt.type !== event.type
    || !validateFeeReceipt(event.type, receipt.payload, receipt.publisherDid ?? '')) {
    throw new Error('Fee receipt verification failed');
  }
  const payload = receipt.payload;
  await materializeVerifiedFeeReceipt(payload, receipt.id);
};

/** Internal materialization after verification; exported for DB characterization fixtures. */
export async function materializeVerifiedFeeReceipt(payload: FeeReceiptPayload, receiptId: string): Promise<void> {
  await db.transaction(async tx => {
    const inserted = await tx.insert(feeLedger).values({
      id: feeLedgerRowId(payload.loopId),
      receiptId,
      transactionId: payload.transactionId,
      recipientDid: payload.recipientDid,
      role: payload.role,
      amountCents: payload.amountCents,
      currency: payload.currency,
      status: payload.status,
      createdAt: new Date(payload.at),
    }).onConflictDoNothing().returning({ id: feeLedger.id });
    if (inserted.length === 0 || !payload.tax) return;
    await tx.insert(transactions).values(taxTransaction(payload, receiptId)).onConflictDoNothing();
  });
}

function taxTransaction(payload: FeeReceiptPayload, receiptId: string) {
  const tax = payload.tax!;
  return {
    id: `tx_${feeLedgerRowId(payload.loopId).slice(3)}`,
    idempotencyKey: `tax:${payload.loopId}`,
    service: tax.service,
    type: 'tax',
    fromDid: tax.buyerDid,
    toDid: payload.recipientDid,
    amount: (payload.amountCents / 100).toFixed(2),
    currency: payload.currency,
    unit: 'MJN',
    sourceKind: 'receipt',
    status: 'completed',
    source: 'external',
    createdAt: new Date(payload.at),
    metadata: {
      role: 'tax', tax: true, jurisdiction: tax.jurisdiction, kind: tax.kind,
      rateBps: tax.rateBps, remitTo: tax.remitTo, registrationNumber: tax.registrationNumber,
      trustLiability: true, remitted: null, funded: true, funded_provider: 'stripe',
      balance_skipped: true, reason: 'externally_funded_seller',
      checkoutTransactionId: payload.transactionId, receiptId,
    },
  };
}

export function ensureFeeLedgerReactorRegistered(): void {
  registerReactor('fee-ledger', feeLedgerReactor);
}
