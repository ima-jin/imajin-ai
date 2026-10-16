import { stripeEventAmount, type StripeWebhookEventType } from './webhook-events';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validCurrency(value: unknown): boolean {
  return typeof value === 'string' && /^[a-z]{3}$/i.test(value);
}

function validMoney(type: StripeWebhookEventType, object: Record<string, unknown>): boolean {
  // Stripe setup-mode Checkout sessions can complete without an amount or currency.
  if (type === 'checkout.session.completed' && object.amount_total === null) {
    return object.currency === null || validCurrency(object.currency);
  }
  const amount = stripeEventAmount(type, object);
  return amount !== null && Number.isSafeInteger(amount) && amount >= 0 && validCurrency(object.currency);
}

function validArrivalDate(value: unknown): boolean {
  if (value === undefined) return true;
  return typeof value === 'number' && Number.isFinite(value) &&
    !Number.isNaN(new Date(value * 1000).getTime());
}

/** Validate fields used by the publisher, not PaymentIntent fields on unrelated Stripe objects. */
export function isStripeWebhookObject(type: StripeWebhookEventType, object: Record<string, unknown>): boolean {
  if (typeof object.id !== 'string' || !object.id.trim()) return false;
  if (object.metadata !== undefined && object.metadata !== null && !isRecord(object.metadata)) return false;
  if (type.startsWith('customer.subscription.')) {
    return typeof object.status === 'string' && object.status.length > 0;
  }
  if (!validMoney(type, object)) return false;
  return type !== 'payout.paid' || validArrivalDate(object.arrival_date);
}
