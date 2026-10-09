/**
 * Stripe implementation of `WithdrawRail` (#2172).
 *
 * The only file outside the pre-existing, allowlisted call sites
 * (`scripts/stripe-import-allowlist.json`) that imports the `stripe`
 * package for the withdraw/reconciliation path — everything else in
 * `lib/pay/rails/` and the withdraw/reconciliation code talks to the
 * `WithdrawRail` interface only. Reuses the shared lazy `getStripeClient()`
 * singleton from `./stripe-client` (#2174 — the same adapter client
 * `webhook-handlers.ts` reads balance-transaction fees from) rather than
 * constructing its own client.
 *
 * #2757: RETIRED for new withdrawals. `execute()` used to `transfers.create`
 * to a seller's Stripe Connect account; Connect is gone and withdrawals run
 * on the EMT request path (`app/pay/api/balance/withdraw/request`). What
 * remains is the read-only side — `list()` and `confirmFromEvent()` — so a
 * withdrawal intent that was already in flight when Connect was removed still
 * reconciles against Stripe's transfer feed instead of being orphaned.
 */
import type Stripe from 'stripe';
import { getStripeClient } from './stripe-client';
import type {
  WithdrawRail,
  WithdrawalIntent,
  WithdrawRailExecuteResult,
  ListTransfersParams,
  RailTransfer,
} from '../rails/types';

export const STRIPE_RAIL_NAME = 'stripe';

/** Narrow, unknown-safe check for a Stripe `transfer.created` event payload. */
function isTransferCreatedEvent(payload: unknown): payload is Stripe.Event & { data: { object: Stripe.Transfer } } {
  if (!payload || typeof payload !== 'object') return false;
  const event = payload as { type?: unknown; data?: { object?: unknown } };
  return event.type === 'transfer.created' && !!event.data?.object;
}

export class StripeWithdrawRail implements WithdrawRail {
  readonly name = STRIPE_RAIL_NAME;

  execute(intent: WithdrawalIntent): Promise<WithdrawRailExecuteResult> {
    // A caller that reserved funds then reaches here releases the reservation
    // (`executeWithdrawal` releases on a rail throw), so nothing is stranded.
    return Promise.reject(
      new Error(`StripeWithdrawRail.execute: intent ${intent.id} refused — Stripe withdrawals are retired (#2757); use the EMT withdrawal request`),
    );
  }

  async list({ since }: ListTransfersParams): Promise<RailTransfer[]> {
    const stripe = getStripeClient();
    const transfers = await stripe.transfers.list({
      created: { gte: Math.floor(since.getTime() / 1000) },
      limit: 100,
    });

    return transfers.data.map((transfer) => ({
      externalRef: transfer.id,
      intentId: typeof transfer.metadata?.intent_id === 'string' ? transfer.metadata.intent_id : null,
      amount: transfer.amount / 100,
      unit: 'MJN',
      createdAt: new Date(transfer.created * 1000),
    }));
  }

  confirmFromEvent(payload: unknown): Promise<{ intentId: string; externalRef: string } | null> {
    if (!isTransferCreatedEvent(payload)) return Promise.resolve(null);
    const transfer = payload.data.object;
    const intentId = transfer.metadata?.intent_id;
    if (typeof intentId !== 'string') return Promise.resolve(null);
    return Promise.resolve({ intentId, externalRef: transfer.id });
  }
}
