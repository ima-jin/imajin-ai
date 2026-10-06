import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  formatInvoiceDate,
  invoiceNumberOf,
  issuerAddressOf,
  publicSettlementOf,
  settlementRefLabel,
} from '../invoice';

beforeAll(() => {
  vi.stubEnv('TZ', 'America/Toronto');
});
afterAll(() => {
  vi.unstubAllEnvs();
});

describe('invoiceNumberOf (#2661)', () => {
  it('derives a short, stable number from the internal id', () => {
    expect(invoiceNumberOf('invoice', 'pr_3f9a1c07d2aabbccddeeff00')).toBe('INV-3F9A1C07D2');
    expect(invoiceNumberOf('invoice', 'pr_3f9a1c07d2aabbccddeeff00')).toBe('INV-3F9A1C07D2');
  });

  it('prefixes a non-invoice request differently', () => {
    expect(invoiceNumberOf('request', 'pr_3f9a1c07d2aabbccddeeff00')).toBe('REQ-3F9A1C07D2');
  });

  it('does not reveal the full internal id', () => {
    expect(invoiceNumberOf('invoice', 'pr_3f9a1c07d2aabbccddeeff00')).not.toContain('AABBCC');
  });
});

describe('issuerAddressOf (#2661)', () => {
  it('reads and trims metadata.location', () => {
    expect(issuerAddressOf({ metadata: { location: '  1 Example St\nToronto ' } })).toBe('1 Example St\nToronto');
  });

  it.each([
    ['no profile', undefined],
    ['no metadata', {}],
    ['a blank location', { metadata: { location: '   ' } }],
    ['a non-string location', { metadata: { location: 42 } }],
  ])('is null for %s', (_label, profile) => {
    expect(issuerAddressOf(profile)).toBeNull();
  });

  it('honours the field visibility rule: only a public (or absent) location is printed', () => {
    const metadata = { location: '1 Example St' };
    expect(issuerAddressOf({ metadata, fieldVisibility: { location: { level: 'public' } } })).toBe('1 Example St');
    expect(issuerAddressOf({ metadata, fieldVisibility: { phone: { level: 'private' } } })).toBe('1 Example St');
    for (const level of ['private', 'connections', 'selective']) {
      expect(issuerAddressOf({ metadata, fieldVisibility: { location: { level } } })).toBeNull();
    }
  });
});

describe('publicSettlementOf (#2661)', () => {
  it('is empty for an unsettled request', () => {
    expect(publicSettlementOf(null)).toEqual({ paidAt: null, settlement: null });
    expect(publicSettlementOf('nonsense')).toEqual({ paidAt: null, settlement: null });
  });

  it('prefers the PaymentIntent over the Checkout session as the reference', () => {
    expect(
      publicSettlementOf({ method: 'stripe', settled_at: '2026-10-09T18:45:00.000Z', checkout_session_id: 'cs_1', payment_intent_id: 'pi_1' }),
    ).toEqual({ paidAt: '2026-10-09T18:45:00.000Z', settlement: { method: 'stripe', reference: 'pi_1' } });
    expect(publicSettlementOf({ method: 'stripe', checkout_session_id: 'cs_1', payment_intent_id: null }).settlement).toEqual({
      method: 'stripe',
      reference: 'cs_1',
    });
  });

  it('never carries the free-text note or the asserter', () => {
    const result = publicSettlementOf({ method: 'manual', settled_at: '2026-10-09T00:00:00.000Z', note: 'secret', asserted_by: 'did:imajin:x' });
    expect(result.settlement).toEqual({ method: 'manual', reference: null });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('did:imajin');
  });

  it('#2665: an e-Transfer settlement carries the memo as its reference — and still never the note or the asserter', () => {
    const result = publicSettlementOf({
      method: 'emt',
      settled_at: '2026-10-09T18:45:00.000Z',
      reference: 'INV-3F9A1C07D2',
      asserted_by: 'did:imajin:issuer',
      note: 'secret',
    });
    expect(result).toEqual({ paidAt: '2026-10-09T18:45:00.000Z', settlement: { method: 'emt', reference: 'INV-3F9A1C07D2' } });
    expect(JSON.stringify(result)).not.toContain('did:imajin');
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('keeps the date even when the method is missing', () => {
    expect(publicSettlementOf({ settled_at: '2026-10-09T00:00:00.000Z' })).toEqual({ paidAt: '2026-10-09T00:00:00.000Z', settlement: null });
  });
});

describe('formatInvoiceDate / settlementRefLabel (#2661)', () => {
  it('renders the entered due date as YYYY-MM-DD, not a day early west of UTC (#2651)', () => {
    expect(formatInvoiceDate('2026-10-06T00:00:00.000Z')).toBe('2026-10-06');
  });

  it('is empty for an unparseable value', () => {
    expect(formatInvoiceDate('garbage')).toBe('');
  });

  it('joins method and reference, or shows the method alone', () => {
    expect(settlementRefLabel({ method: 'stripe', reference: 'pi_1' })).toBe('stripe · pi_1');
    expect(settlementRefLabel({ method: 'manual', reference: null })).toBe('manual');
  });

  it('#2665: names the e-Transfer rail readably on a receipt', () => {
    expect(settlementRefLabel({ method: 'emt', reference: 'INV-3F9A1C07D2' })).toBe('e-Transfer · INV-3F9A1C07D2');
    expect(settlementRefLabel({ method: 'emt', reference: null })).toBe('e-Transfer');
  });
});
