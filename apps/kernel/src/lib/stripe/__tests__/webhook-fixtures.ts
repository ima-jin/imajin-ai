import type { StripeWebhookEventType } from '../webhook-events';

/** Real event-specific field shapes, especially subscriptions without a PaymentIntent amount. */
export const stripeWebhookObjects = {
  'payment_intent.succeeded': { id: 'pi_fake', amount: 1200, currency: 'cad' },
  'payment_intent.payment_failed': { id: 'pi_fake_failed', amount: 1200, currency: 'cad' },
  'checkout.session.completed': { id: 'cs_fake', amount_total: 2400, currency: 'cad', payment_status: 'paid' },
  'customer.subscription.created': { id: 'sub_fake_created', status: 'active', currency: 'cad' },
  'customer.subscription.updated': { id: 'sub_fake_updated', status: 'past_due', currency: 'cad' },
  'customer.subscription.deleted': { id: 'sub_fake_deleted', status: 'canceled', currency: 'cad' },
  'invoice.paid': { id: 'in_fake', amount_paid: 3600, currency: 'cad' },
  'payout.paid': { id: 'po_fake', amount: 4800, currency: 'cad', arrival_date: 1_700_000_000 },
} satisfies Record<StripeWebhookEventType, Record<string, unknown>>;
