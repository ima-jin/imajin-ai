/**
 * Pay webhook ingress -> connector bus relay (#2177).
 *
 * What the two legacy pay webhook routes now do once a delivery's signature
 * has verified (`providers/stripe-webhook.ts`): republish it onto the #1785
 * connector bus as a `stripe.<event type>` event and let the `pay-stripe`
 * reactor (`stripe-bus-consumer.ts`) do the work. See that module for the
 * settlement seam, and `stripe-relay-store.ts` for why the raw Stripe event
 * is handed over in-process instead of riding in the bus payload.
 *
 * The bus envelope is attributed to the platform DID (the platform's own
 * Stripe account is "the owner" here, exactly as a BYO owner is for the
 * connector's events); `ownerDid` in the payload says so explicitly.
 */

import { randomUUID } from 'node:crypto';
import { publish, type BusEventMap, type BusEventType } from '@imajin/bus';
import { createLogger } from '@imajin/logger';
import { ensurePayStripeReactorRegistered, hasStripeBusHandler } from '@/src/lib/pay/stripe-bus-consumer';
import {
  deleteRelayEntry,
  putRelayEntry,
  type StripeRelaySource,
} from '@/src/lib/pay/stripe-relay-store';

const log = createLogger('kernel');

/** Bus scope for every `stripe.*` event, shared with the BYO connector (`connector.ts`). */
const STRIPE_BUS_SCOPE = 'stripe';

export type StripeRelayResult =
  /** Published and fully handled by the consumer. */
  | { status: 'handled' }
  /** No pay handler exists for this event type on this endpoint — acknowledge only. */
  | { status: 'ignored' }
  /** Publish failed, the consumer threw, or the consumer never ran. The caller must answer non-2xx so Stripe retries. */
  | { status: 'failed'; reason: string };

/** The slice of a verified Stripe event the relay reads — everything else stays in the in-process store. */
interface RelayableStripeEvent {
  id?: unknown;
  type?: unknown;
  data?: { object?: unknown };
}

/** Same per-type amount fields `toRailEvent` normalizes (see `extractAmount`); every other type uses `amount`. */
const AMOUNT_FIELD_BY_TYPE: Readonly<Record<string, string>> = {
  'checkout.session.completed': 'amount_total',
  'invoice.paid': 'amount_paid',
};

function platformDid(): string {
  return process.env.PLATFORM_DID || 'system';
}

/** Read a string field off a Stripe object, `''` when absent or not a string. */
function stringField(object: Record<string, unknown>, key: string): string {
  const value = object[key];
  return typeof value === 'string' ? value : '';
}

/** Non-sensitive facts about the event — safe for the durable, subscriber-visible bus payload. */
function describeEvent(event: RelayableStripeEvent): {
  eventId: string;
  objectId: string;
  amount: number | null;
  currency: string | null;
} {
  const object = (event.data?.object ?? {}) as Record<string, unknown>;
  const amount = object[AMOUNT_FIELD_BY_TYPE[String(event.type)] ?? 'amount'];
  const currency = stringField(object, 'currency');
  return {
    eventId: typeof event.id === 'string' ? event.id : '',
    objectId: stringField(object, 'id'),
    amount: typeof amount === 'number' ? amount : null,
    currency: currency ? currency.toUpperCase() : null,
  };
}

/**
 * The three types the BYO connector also publishes (`connector.ts`) keep the
 * connector's type-specific field names, so one `stripe.*` type has one
 * payload shape no matter who published it (the generic `objectId`/`amount`
 * facts are still present alongside).
 */
function connectorShapedFields(
  eventType: string,
  facts: ReturnType<typeof describeEvent>,
): Record<string, unknown> {
  switch (eventType) {
    case 'payment_intent.succeeded':
      return { paymentIntentId: facts.objectId };
    case 'invoice.paid':
      return { invoiceId: facts.objectId, amountPaid: facts.amount ?? 0 };
    case 'payout.paid':
      return { payoutId: facts.objectId, arrivalDate: null };
    default:
      return {};
  }
}

/**
 * Republish one signature-verified Stripe delivery onto the bus and report
 * whether the pay consumer handled it. Never throws.
 *
 * `source` records which webhook endpoint (and signing secret) verified the
 * delivery; the consumer only dispatches handlers registered for that source.
 */
export async function relayVerifiedStripeEvent(
  stripeEvent: unknown,
  source: StripeRelaySource,
): Promise<StripeRelayResult> {
  const event = stripeEvent as RelayableStripeEvent;
  const eventType = typeof event?.type === 'string' ? event.type : '';
  if (!hasStripeBusHandler(source, eventType)) {
    return { status: 'ignored' };
  }

  ensurePayStripeReactorRegistered();

  const relayId = randomUUID();
  const entry = putRelayEntry(relayId, source, stripeEvent);
  const owner = platformDid();
  const facts = describeEvent(event);

  try {
    // The `stripe.<type>` payload shapes are declared per type in
    // `BusEventMap`; the type is dynamic here, so the payload is asserted to
    // the union of them (every shape carries these same common fields).
    await publish(`stripe.${eventType}` as BusEventType, {
      issuer: owner,
      subject: owner,
      scope: STRIPE_BUS_SCOPE,
      payload: {
        ownerDid: owner,
        ...facts,
        ...connectorShapedFields(eventType, facts),
        source,
        relayId,
        context_id: facts.eventId,
        context_type: 'stripe',
      } as unknown as BusEventMap[BusEventType],
    });
  } catch (error) {
    log.error({ err: String(error), eventType, source }, 'Stripe webhook: bus publish failed');
    return { status: 'failed', reason: `publish failed: ${String(error)}` };
  } finally {
    deleteRelayEntry(relayId);
  }

  if (entry.error) {
    return { status: 'failed', reason: entry.error };
  }
  if (!entry.handled) {
    // `publish()` completed but the consumer never ran — e.g. the
    // `stripe.<type>` chain was disabled or replaced in
    // `kernel.bus_chain_configs`. Acknowledging would drop the payment
    // silently, so fail the delivery loudly instead.
    log.error({ eventType, source }, 'Stripe webhook: pay-stripe reactor did not handle the relayed event');
    return { status: 'failed', reason: 'pay-stripe reactor did not run' };
  }
  return { status: 'handled' };
}
