/**
 * POST /api/webhook/settlement
 *
 * Receives settlement.completed events from the bus system.
 * Writes the resolved .fair settlement snapshot to the order record.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@imajin/logger';
import { db, orders } from '@/src/db';
import { eq } from 'drizzle-orm';

const log = createLogger('events');
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

interface SettlementPayload {
  orderId: string;
  eventId: string;
  buyerDid: string;
  amount: number;
  currency: string;
  totalAmount: number;
  netAmount: number;
  fees: Array<{ role: string; name: string; rateBps: number; fixedCents: number; amount: number; estimated: boolean }>;
  chain: Array<{ did: string; amount: number; role: string }>;
  metadata?: Record<string, unknown>;
}
interface BusWebhookEnvelope<TPayload> {
  payload?: TPayload;
}

export async function POST(request: NextRequest) {
  try {
    const secret = request.headers.get('x-webhook-secret');
    if (!WEBHOOK_SECRET || secret !== WEBHOOK_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = (await request.json()) as SettlementPayload | BusWebhookEnvelope<SettlementPayload>;
    const payload = ((body as BusWebhookEnvelope<SettlementPayload>).payload ?? body) as SettlementPayload;

    if (!payload.orderId || typeof payload.orderId !== 'string') {
      return NextResponse.json({ error: 'Missing orderId' }, { status: 400 });
    }

    const fairSettlement = {
      version: '1.1',
      settledAt: new Date().toISOString(),
      totalAmount: payload.totalAmount,
      netAmount: payload.netAmount,
      currency: payload.currency,
      fees: payload.fees,
      chain: payload.chain,
    };

    await db
      .update(orders)
      .set({ fairSettlement })
      .where(eq(orders.id, payload.orderId));

    log.info({ orderId: payload.orderId }, '.fair settlement snapshot saved to order');

    return NextResponse.json({ received: true });
  } catch (error) {
    log.error({ err: String(error) }, 'Settlement webhook error');
    return NextResponse.json(
      { error: 'Webhook processing failed' },
      { status: 500 }
    );
  }
}
