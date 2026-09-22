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
 */
import type Stripe from 'stripe';
import { fromDecimalString } from '@imajin/money';
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

  async execute(intent: WithdrawalIntent): Promise<WithdrawRailExecuteResult> {
    if (!intent.destination) {
      throw new Error(`StripeWithdrawRail.execute: intent ${intent.id} has no destination account`);
    }

    const stripe = getStripeClient();
    const currency = intent.currency ?? 'CAD';
    // Exact decimal string -> integer minor units via `@imajin/money`
    // (`fromDecimalString` -> `parseDecimalToFraction` + `bigintToSafeNumber`
    // internally) — never `parseFloat`/`Math.round` on a value that moves
    // real money.
    const amountMinorUnits = fromDecimalString(intent.amount, currency).amount;
    const transfer = await stripe.transfers.create(
      {
        amount: amountMinorUnits,
        currency: currency.toLowerCase(),
        destination: intent.destination,
        metadata: {
          intent_id: intent.id,
          did: intent.did,
        },
      },
      // Native idempotency (#2172 seam notes: absent from the withdraw
      // route today) — a retry against the same intent can never create a
      // second Stripe transfer.
      { idempotencyKey: intent.idempotencyKey },
    );

    return { externalRef: transfer.id };
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

  async confirmFromEvent(payload: unknown): Promise<{ intentId: string; externalRef: string } | null> {
    if (!isTransferCreatedEvent(payload)) return null;
    const transfer = payload.data.object;
    const intentId = transfer.metadata?.intent_id;
    if (typeof intentId !== 'string') return null;
    return { intentId, externalRef: transfer.id };
  }
}
