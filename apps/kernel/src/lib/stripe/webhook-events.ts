/** Owner connector subscription contract. Legacy-only transfer.created is not connector ingress. */
export const stripeWebhookEvents = [
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'payout.paid',
] as const;

export type StripeWebhookEventType = typeof stripeWebhookEvents[number];

export function isStripeWebhookEventType(type: string): type is StripeWebhookEventType {
  return (stripeWebhookEvents as readonly string[]).includes(type);
}

/** Subscriptions have no event-level amount; do not invent a zero-value payment. */
export function stripeEventAmount(type: string, object: Record<string, unknown>): number | null {
  if (type.startsWith('customer.subscription.')) return null;
  const field = type === 'checkout.session.completed' ? 'amount_total' : 'amount';
  const value = object[type === 'invoice.paid' ? 'amount_paid' : field];
  return typeof value === 'number' ? value : null;
}
