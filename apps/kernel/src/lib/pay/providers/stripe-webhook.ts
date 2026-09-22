/**
 * Stripe webhook adapter (#2175).
 *
 * The ONE place that verifies a Stripe webhook delivery's signature and
 * turns its raw SDK event into a rail-neutral `RailEvent` (see
 * `../rails/types.ts`). Both pay webhook routes
 * (`app/pay/api/webhook/route.ts` and `app/pay/api/connect/webhook/route.ts`)
 * and `webhook-handlers.ts` talk to this module only — neither imports the
 * `stripe` package directly, nor accepts a `Stripe.*` type in a function
 * signature. See `scripts/ci-guard-stripe-import-scope.mjs` for the CI
 * guard that enforces the import half of that invariant.
 *
 * Signature verification is mandatory and un-bypassable: there is no
 * env-flag or code path that skips `stripe.webhooks.constructEvent`.
 *
 * ## Idempotency
 *
 * `verifyStripeWebhook` also guards against a replayed delivery (Stripe
 * retries on a non-2xx response, and operators can manually resend a past
 * event from the dashboard) turning into a duplicate `RailEvent`: it checks
 * the verified event's own `id` (e.g. `evt_123`) against an in-memory,
 * per-process set of already-processed ids. A caller marks an id processed
 * via `markStripeEventProcessed` only once its handling has fully
 * succeeded — not at verification time — so a delivery that fails partway
 * through (500 response) is never wrongly remembered as done and can still
 * be retried by Stripe.
 *
 * This is intentionally in-memory rather than a new persisted table: it is
 * a best-effort, single-process ratchet against the common case (a Stripe
 * retry landing on the same warm process seconds later), layered on top of
 * — not a replacement for — the pre-existing per-object business
 * idempotency checks in `webhook-handlers.ts` / the routes (e.g. "skip if
 * transaction already completed"), which remain the durable, cross-restart
 * safety net. A persisted webhook-delivery log is out of scope for this
 * change (tracked separately, see #2176).
 */
import Stripe from 'stripe';
import { createLogger } from '@imajin/logger';
import { getStripeClient } from './stripe-client';
import type { RailEvent } from '../rails/types';

const log = createLogger('kernel');

/** Stripe event types this adapter knows how to normalize into a `RailEvent`. */
const NORMALIZABLE_EVENT_TYPES = new Set([
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'account.updated',
  'payout.paid',
  'payout.failed',
]);

// ---------------------------------------------------------------------------
// Signature verification + idempotency
// ---------------------------------------------------------------------------

export type StripeWebhookVerifyResult =
  | { ok: true; duplicate: true; eventId: string }
  | { ok: true; duplicate: false; eventId: string | undefined; eventType: string; event: unknown }
  | { ok: false; status: 400 | 500; reason: string };

/**
 * Crude bound on the in-memory dedup set so a very long-lived process can
 * never grow it unboundedly. Not a sliding window — just a full reset once
 * the bound is hit, which only matters for a process handling tens of
 * thousands of webhook deliveries without a restart.
 */
const MAX_TRACKED_EVENT_IDS = 10_000;
const processedEventIds = new Set<string>();

/** True when `eventId` has already been marked processed via `markStripeEventProcessed`. */
export function isDuplicateStripeEvent(eventId: string | undefined): boolean {
  return !!eventId && processedEventIds.has(eventId);
}

/** Mark a verified event's id as fully handled, so a later replay of the same delivery is recognized as a duplicate. No-op when `eventId` is absent. */
export function markStripeEventProcessed(eventId: string | undefined): void {
  if (!eventId) return;
  if (processedEventIds.size >= MAX_TRACKED_EVENT_IDS) {
    processedEventIds.clear();
  }
  processedEventIds.add(eventId);
}

/**
 * Verify a raw webhook delivery's signature (mandatory, never bypassed) and
 * check it against the in-memory idempotency set.
 *
 * Returns `duplicate: true` without re-verifying anything expensive once an
 * id is recognized — a replay is still signature-verified first, so a
 * *forged* delivery reusing a real event id is still rejected the same way
 * any other invalid signature is (via the `constructEvent` call below,
 * which runs unconditionally).
 */
export function verifyStripeWebhook(
  rawBody: string,
  signatureHeader: string | null,
  secret: string | undefined,
): StripeWebhookVerifyResult {
  if (!secret) {
    return { ok: false, status: 500, reason: 'Webhook not configured' };
  }
  if (!signatureHeader) {
    return { ok: false, status: 400, reason: 'Missing stripe-signature header' };
  }

  let event: Stripe.Event;
  try {
    event = getStripeClient().webhooks.constructEvent(rawBody, signatureHeader, secret);
  } catch (err) {
    log.error({ err: String(err) }, 'Stripe webhook signature verification failed');
    return { ok: false, status: 400, reason: 'Invalid signature' };
  }

  if (isDuplicateStripeEvent(event.id)) {
    return { ok: true, duplicate: true, eventId: event.id };
  }

  return { ok: true, duplicate: false, eventId: event.id, eventType: event.type, event };
}

// ---------------------------------------------------------------------------
// RailEvent normalization
// ---------------------------------------------------------------------------

interface StripeEventLike {
  type: string;
  data?: { object?: unknown };
}

function extractAmount(type: string, object: Record<string, unknown>): number | null {
  if (type === 'checkout.session.completed') {
    return typeof object.amount_total === 'number' ? object.amount_total : null;
  }
  if (type === 'invoice.paid') {
    return typeof object.amount_paid === 'number' ? object.amount_paid : null;
  }
  return typeof object.amount === 'number' ? object.amount : null;
}

/**
 * Normalize a verified Stripe event (as returned by `verifyStripeWebhook`)
 * into a rail-neutral `RailEvent`. Returns `null` for an event type this
 * adapter doesn't normalize (e.g. `transfer.created`, which stays on the
 * pre-existing `WithdrawRail.confirmFromEvent` fast path — see the pay
 * webhook route) — callers fall back to their own unhandled-event logging
 * in that case.
 */
export function toRailEvent(event: unknown): RailEvent | null {
  const candidate = event as StripeEventLike | null | undefined;
  const object = candidate?.data?.object;
  if (!candidate || typeof candidate.type !== 'string' || !object || typeof object !== 'object') {
    return null;
  }
  if (!NORMALIZABLE_EVENT_TYPES.has(candidate.type)) {
    return null;
  }

  const raw = object as Record<string, unknown>;
  const externalRef = typeof raw.id === 'string' ? raw.id : null;
  const currency = typeof raw.currency === 'string' ? raw.currency : null;

  return {
    rail: 'stripe',
    type: candidate.type,
    externalRef,
    amount: extractAmount(candidate.type, raw),
    currency,
    raw,
  };
}

// ---------------------------------------------------------------------------
// Actual processing fee lookup (moved from webhook-handlers.ts's
// `fetchActualStripeFee`, which now delegates here — #2175)
// ---------------------------------------------------------------------------

/**
 * Attempt to retrieve the actual Stripe processing fee from the
 * balance_transaction attached to a payment intent. Returns `null` when the
 * fee cannot be read (not yet settled, API error, etc.) — never throws.
 */
export async function fetchActualFee(paymentIntentId: string): Promise<number | null> {
  try {
    const stripe = getStripeClient();
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
      expand: ['latest_charge.balance_transaction'],
    });
    const charge = pi.latest_charge as Stripe.Charge | null;
    const bt = charge?.balance_transaction as Stripe.BalanceTransaction | null | undefined;
    return bt?.fee ?? null;
  } catch (err) {
    log.warn({ err: String(err) }, '[stripe-webhook] Failed to fetch balance_transaction — using estimate');
    return null;
  }
}

/** Test-only: reset the in-memory idempotency set between test cases that deliberately reuse a fixed event id. */
export function __resetStripeWebhookDedupForTests(): void {
  processedEventIds.clear();
}
