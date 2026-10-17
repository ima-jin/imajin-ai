import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

vi.mock('@imajin/bus', () => ({ publish: vi.fn() }));
import { stripeWebhookEvents, isStripeWebhookEventType, stripeEventAmount } from '../webhook-events';
import { stripeWebhookHandlers } from '../webhook-routing';
import { isStripeWebhookObject } from '../webhook-payload';
import { stripeWebhookObjects } from './webhook-fixtures';

describe('Stripe owner event contract', () => {
  it('is exactly bidirectional: advertised events, fixtures and publishers have the same keys', () => {
    expect(stripeWebhookEvents).toHaveLength(8);
    expect(new Set(stripeWebhookEvents).size).toBe(8);
    expect(Object.keys(stripeWebhookHandlers).sort()).toEqual([...stripeWebhookEvents].sort());
    expect(Object.keys(stripeWebhookObjects).sort()).toEqual([...stripeWebhookEvents].sort());
    expect(isStripeWebhookEventType('transfer.created')).toBe(false);
    expect(isStripeWebhookEventType('charge.dispute.created')).toBe(false);
  });
  it('accepts explicit null monetary fields on setup Checkout, not missing or malformed fields', () => {
    expect(isStripeWebhookObject('checkout.session.completed', { id: 'cs_fake', amount_total: null, currency: null })).toBe(true);
    expect(isStripeWebhookObject('checkout.session.completed', { id: 'cs_fake', amount_total: null, currency: 'cad' })).toBe(true);
    expect(isStripeWebhookObject('checkout.session.completed', { id: 'cs_fake', amount_total: null, currency: 'invalid' })).toBe(false);
    expect(isStripeWebhookObject('checkout.session.completed', { id: 'cs_fake' })).toBe(false);
    expect(isStripeWebhookObject('payment_intent.succeeded', { id: 'pi_fake', amount: null, currency: 'cad' })).toBe(false);
  });

  it('documents all eight and keeps legacy-only transfers separate', () => {
    const spec = parse(readFileSync('apps/kernel/api-spec/pay.yaml', 'utf8'));
    const description = spec.paths['/api/webhook/did/{routingId}'].post.description;
    for (const type of stripeWebhookEvents) expect(description).toContain(type);
    expect(description).toContain('transfer.created remains a legacy-only');
  });

  it.each(stripeWebhookEvents)('validates the event-specific %s fixture', (type) => {
    expect(isStripeWebhookEventType(type)).toBe(true);
    expect(isStripeWebhookObject(type, stripeWebhookObjects[type])).toBe(true);
  });

  it.each(stripeWebhookEvents)('rejects missing ids and malformed metadata for %s', (type) => {
    expect(isStripeWebhookObject(type, { ...stripeWebhookObjects[type], id: ' ' })).toBe(false);
    expect(isStripeWebhookObject(type, { ...stripeWebhookObjects[type], metadata: [] })).toBe(false);
  });

  it.each(['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'] as const)(
    '%s has no amount and requires subscription status, not PaymentIntent fields', (type) => {
      expect(stripeEventAmount(type, { ...stripeWebhookObjects[type], amount: 999 })).toBeNull();
      expect(isStripeWebhookObject(type, { id: 'sub_fake', status: 'active' })).toBe(true);
      expect(isStripeWebhookObject(type, { id: 'sub_fake', amount: 100, currency: 'cad' })).toBe(false);
    },
  );

  it.each([
    ['payment_intent.succeeded', 'amount'],
    ['payment_intent.payment_failed', 'amount'],
    ['checkout.session.completed', 'amount_total'],
    ['invoice.paid', 'amount_paid'],
    ['payout.paid', 'amount'],
  ] as const)('%s requires a non-negative integer %s and valid currency', (type, field) => {
    const fixture = stripeWebhookObjects[type];
    for (const value of [undefined, '100', -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(isStripeWebhookObject(type, { ...fixture, [field]: value })).toBe(false);
    }
    for (const currency of [undefined, null, 123, '', 'cads']) {
      expect(isStripeWebhookObject(type, { ...fixture, currency })).toBe(false);
    }
    expect(isStripeWebhookObject(type, { ...fixture, [field]: 0, metadata: null })).toBe(true);
  });

  it.each([null, 'tomorrow', Infinity, 1e20])('rejects invalid payout arrival date %s', (arrival_date) => {
    expect(isStripeWebhookObject('payout.paid', { ...stripeWebhookObjects['payout.paid'], arrival_date })).toBe(false);
  });

  it('permits an omitted payout arrival date', () => {
    expect(isStripeWebhookObject('payout.paid', { id: 'po_fake', amount: 0, currency: 'usd' })).toBe(true);
  });
});
