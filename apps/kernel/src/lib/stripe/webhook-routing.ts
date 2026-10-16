import { publish, type BusEventMap } from '@imajin/bus';
import { stripeEventAmount, type StripeWebhookEventType } from './webhook-events';
import { isRecord } from './webhook-payload';

interface Delivery {
  ownerDid: string;
  relayId: string;
  eventId: string;
  object: Record<string, unknown>;
}

type Handler = (delivery: Delivery) => Promise<void>;
type Common = 'ownerDid' | 'relayId' | 'eventId' | 'context_id' | 'context_type';

/** Only explicit settlement references may leave PaymentIntent metadata; never customer data. */
function checkoutReferences(object: Record<string, unknown>): { paymentRequestId?: string; payTransactionId?: string } {
  const metadata = isRecord(object.metadata) ? object.metadata : {};
  const nonEmpty = (value: unknown) => typeof value === 'string' && value.length > 0 ? value : undefined;
  const paymentRequestId = nonEmpty(metadata.payment_request_id) ?? nonEmpty(metadata.paymentRequestId);
  const payTransactionId = nonEmpty(metadata.pay_transaction_id);
  return {
    ...(paymentRequestId && { paymentRequestId }),
    ...(payTransactionId && { payTransactionId }),
  };
}

function currency(object: Record<string, unknown>): string {
  return typeof object.currency === 'string' ? object.currency.toUpperCase() : '';
}

function onEvent<T extends StripeWebhookEventType>(
  type: T,
  fields: (object: Record<string, unknown>) => Omit<BusEventMap[`stripe.${T}`], Common>,
): Handler {
  return async ({ ownerDid, relayId, eventId, object }) => {
    // Each factory is checked against the existing bus type; raw Stripe objects stay in the relay store.
    const payload = {
      ownerDid, relayId, eventId, context_id: eventId, context_type: 'stripe' as const, ...fields(object),
    } as BusEventMap[`stripe.${T}`];
    await publish(`stripe.${type}`, { issuer: ownerDid, subject: ownerDid, scope: 'stripe', payload });
  };
}

function facts(type: StripeWebhookEventType, object: Record<string, unknown>) {
  return { objectId: object.id as string, amount: stripeEventAmount(type, object), currency: currency(object) || null };
}

function subscriptionFacts(object: Record<string, unknown>) {
  return { objectId: object.id as string, amount: null, currency: currency(object) || null };
}

/** Exactly one publisher per advertised event, enforced bidirectionally by the contract suite. */
export const stripeWebhookHandlers = {
  'payment_intent.succeeded': onEvent('payment_intent.succeeded', (object) => ({
    paymentIntentId: object.id as string, amount: object.amount as number, currency: currency(object),
    ...checkoutReferences(object),
  })),
  'payment_intent.payment_failed': onEvent('payment_intent.payment_failed', (object) => facts('payment_intent.payment_failed', object)),
  'checkout.session.completed': onEvent('checkout.session.completed', (object) => facts('checkout.session.completed', object)),
  'customer.subscription.created': onEvent('customer.subscription.created', subscriptionFacts),
  'customer.subscription.updated': onEvent('customer.subscription.updated', subscriptionFacts),
  'customer.subscription.deleted': onEvent('customer.subscription.deleted', subscriptionFacts),
  'invoice.paid': onEvent('invoice.paid', (object) => ({
    invoiceId: object.id as string, amountPaid: object.amount_paid as number, currency: currency(object),
  })),
  'payout.paid': onEvent('payout.paid', (object) => ({
    payoutId: object.id as string, amount: object.amount as number, currency: currency(object),
    arrivalDate: typeof object.arrival_date === 'number' ? new Date(object.arrival_date * 1000).toISOString() : null,
  })),
} satisfies Record<StripeWebhookEventType, Handler>;
