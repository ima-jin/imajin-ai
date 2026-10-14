import { createHash, randomUUID } from 'node:crypto';
import { and, eq, isNull, or } from 'drizzle-orm';
import { db } from '@/src/db';
import { transactions } from '@/src/db/schemas/pay';
import type { ChargeRequest, ChargeResult, EscrowRequest, EscrowResult } from '../types';

export class SellerChargeAlreadyAttemptedError extends Error {
  readonly code = 'SELLER_CHARGE_ALREADY_ATTEMPTED';
  constructor() {
    super('Seller charge already attempted; reconcile before retrying');
  }
}

export async function prepareSellerCharge(request: ChargeRequest, sellerDid: string, appDid?: string): Promise<string> {
  const transactionId = request.idempotencyKey
    ? `tx_${createHash('sha256').update(JSON.stringify([sellerDid, request.from ?? '', appDid ?? '', request.idempotencyKey])).digest('hex')}`
    : `tx_${randomUUID()}`;
  const metadata = Object.fromEntries(Object.entries(request.metadata ?? {})
    .filter(([key]) => key !== 'settledPaymentIntentId' && key !== 'appDid'));
  const [inserted] = await db.insert(transactions).values({
    id: transactionId, service: 'pay', type: 'charge',
    fromDid: request.from || null, toDid: sellerDid,
    amount: (request.amount / 100).toString(), currency: request.currency,
    status: 'pending', source: 'fiat', rail: 'stripe-byo', ...(appDid && { appDid }),
    metadata: { ...metadata, payTransactionId: transactionId, pay_transaction_id: transactionId,
      seller_did: sellerDid, to_did: sellerDid, from_did: request.from || '', rail: 'stripe-byo', ...(appDid && { appDid }) },
  }).onConflictDoNothing({ target: transactions.id }).returning({ id: transactions.id });
  // The row itself is a permanent attempt claim. Never retry an ambiguous PI,
  // including once Stripe's short-lived idempotency cache expires.
  if (!inserted) throw new SellerChargeAlreadyAttemptedError();
  return transactionId;
}

/** Bind the SDK response without resetting a receipt already settled by the webhook. */
export async function persistSellerCharge(transactionId: string, result: ChargeResult) {
  await db.update(transactions).set({ externalRef: result.id }).where(and(
    eq(transactions.id, transactionId), eq(transactions.type, 'charge'), eq(transactions.rail, 'stripe-byo'),
    or(isNull(transactions.externalRef), eq(transactions.externalRef, result.id)),
  ));
}

export async function persistSellerEscrow(result: EscrowResult, request: EscrowRequest) {
  await db.insert(transactions).values({
    id: `tx_${randomUUID()}`, service: 'pay', type: 'escrow',
    fromDid: request.from, toDid: request.to,
    amount: (result.amount / 100).toString(), currency: result.currency,
    status: 'held', source: 'fiat', rail: 'stripe-byo', externalRef: result.id,
    metadata: {
      ...request.metadata, escrow: 'true', seller_did: request.to,
      from_did: request.from, to_did: request.to, arbiter_did: request.arbiter || '',
      rail: 'stripe-byo',
    },
  });
}

/** External references are opaque; never select an account from caller metadata. */
export async function findSellerEscrow(externalRef: string) {
  const [transaction] = await db.select().from(transactions).where(and(
    eq(transactions.externalRef, externalRef), eq(transactions.type, 'escrow'),
  )).limit(1);
  return transaction;
}

export async function markSellerEscrow(id: string, status: 'released' | 'refunded') {
  await db.update(transactions).set({ status }).where(eq(transactions.id, id));
}
