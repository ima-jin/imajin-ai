import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '@/src/db';
import { transactions } from '@/src/db/schemas/pay';
import type { ChargeResult, EscrowRequest, EscrowResult } from '../types';

export async function persistSellerCharge(
  result: ChargeResult, sellerDid: string, fromDid?: string,
) {
  await db.insert(transactions).values({
    id: `tx_${randomUUID()}`, service: 'pay', type: 'charge',
    fromDid: fromDid || null, toDid: sellerDid,
    amount: (result.amount / 100).toString(), currency: result.currency,
    status: result.status === 'succeeded' ? 'completed' : 'pending',
    source: 'fiat', rail: 'stripe-byo', externalRef: result.id,
    metadata: { ...result.metadata, seller_did: sellerDid, to_did: sellerDid, from_did: fromDid || '', rail: 'stripe-byo' },
  });
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
