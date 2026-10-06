import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { buildCreatePaymentRequestBody, previewSubtotal, type CreateFormState } from '../build-create-request';
import type { LineItemDraft, TaxRowDraft } from '../types';

const ISSUER_DID = 'did:imajin:business';

function lineItem(overrides: Partial<LineItemDraft> = {}): LineItemDraft {
  return { key: 'item-1', name: 'Consulting', description: '', quantity: '1', unitAmount: '19.99', ...overrides };
}

function baseState(overrides: Partial<CreateFormState> = {}): CreateFormState {
  return {
    kind: 'invoice',
    currency: 'CAD',
    lineItems: [lineItem()],
    dueAt: '',
    allowOnPlatform: true,
    recipientMode: 'connection',
    selectedConnection: { did: 'did:imajin:customer', name: 'Alice', handle: null },
    invite: { email: '', delivery: 'email', note: '' },
    chargeTax: false,
    taxRows: [],
    ...overrides,
  };
}

describe('buildCreatePaymentRequestBody — line items', () => {
  it('rejects an empty line item list', () => {
    const result = buildCreatePaymentRequestBody(ISSUER_DID, baseState({ lineItems: [] }));
    expect(result).toEqual({ ok: false, error: 'Add at least one line item' });
  });

  it('rejects a line item with no name', () => {
    const result = buildCreatePaymentRequestBody(ISSUER_DID, baseState({ lineItems: [lineItem({ name: '  ' })] }));
    expect(result).toEqual({ ok: false, error: 'Line item 1 needs a name' });
  });

  it('rejects a line item with an invalid unit amount', () => {
    const result = buildCreatePaymentRequestBody(ISSUER_DID, baseState({ lineItems: [lineItem({ unitAmount: 'abc' })] }));
    expect(result).toEqual({ ok: false, error: 'Line item 1 needs a valid unit amount' });
  });

  it('rejects a zero or negative unit amount', () => {
    const result = buildCreatePaymentRequestBody(ISSUER_DID, baseState({ lineItems: [lineItem({ unitAmount: '0' })] }));
    expect(result).toEqual({ ok: false, error: 'Line item 1 needs a valid unit amount' });
  });

  it('rejects a quantity below 1', () => {
    const result = buildCreatePaymentRequestBody(ISSUER_DID, baseState({ lineItems: [lineItem({ quantity: '0' })] }));
    expect(result).toEqual({ ok: false, error: 'Line item 1 needs a quantity of at least 1' });
  });

  it('parses unit amount into minor units via packages/money (no float drift)', () => {
    const result = buildCreatePaymentRequestBody(ISSUER_DID, baseState({ lineItems: [lineItem({ unitAmount: '19.99', quantity: '3' })] }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body.line_items).toEqual([{ name: 'Consulting', amount: 1999, quantity: 3 }]);
    }
  });

  it('includes an optional description only when non-empty', () => {
    const result = buildCreatePaymentRequestBody(ISSUER_DID, baseState({ lineItems: [lineItem({ description: '  Onboarding call  ' })] }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body.line_items).toEqual([{ name: 'Consulting', description: 'Onboarding call', amount: 1999, quantity: 1 }]);
    }
  });
});

describe('buildCreatePaymentRequestBody — recipient (connection mode)', () => {
  it('rejects when no connection is selected', () => {
    const result = buildCreatePaymentRequestBody(ISSUER_DID, baseState({ selectedConnection: null }));
    expect(result).toEqual({ ok: false, error: 'Pick a connection to send this to' });
  });

  it('sends recipient_did for the selected connection', () => {
    const result = buildCreatePaymentRequestBody(ISSUER_DID, baseState());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body.recipient_did).toBe('did:imajin:customer');
      expect(result.body.recipient_invite).toBeUndefined();
    }
  });
});

describe('buildCreatePaymentRequestBody — recipient (invite mode)', () => {
  function inviteState(overrides: Partial<CreateFormState> = {}): CreateFormState {
    return baseState({
      recipientMode: 'invite',
      selectedConnection: null,
      invite: { email: 'customer@example.com', delivery: 'email', note: '' },
      ...overrides,
    });
  }

  it('rejects an empty invite email', () => {
    const result = buildCreatePaymentRequestBody(ISSUER_DID, inviteState({ invite: { email: '  ', delivery: 'email', note: '' } }));
    expect(result).toEqual({ ok: false, error: 'Enter an email to invite' });
  });

  it('sends recipient_invite with the trimmed email and delivery', () => {
    const result = buildCreatePaymentRequestBody(ISSUER_DID, inviteState());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body.recipient_did).toBeUndefined();
      expect(result.body.recipient_invite).toEqual({ email: 'customer@example.com', delivery: 'email' });
    }
  });

  it('includes the invite note only when non-empty', () => {
    const result = buildCreatePaymentRequestBody(
      ISSUER_DID,
      inviteState({ invite: { email: 'customer@example.com', delivery: 'link', note: '  Thanks!  ' } }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body.recipient_invite).toEqual({ email: 'customer@example.com', delivery: 'link', note: 'Thanks!' });
    }
  });
});

describe('buildCreatePaymentRequestBody — other fields', () => {
  it('never includes fair_manifest — the custom-manifest editor is out of scope', () => {
    const result = buildCreatePaymentRequestBody(ISSUER_DID, baseState());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body.fair_manifest).toBeUndefined();
    }
  });

  it('omits due_at when not set', () => {
    const result = buildCreatePaymentRequestBody(ISSUER_DID, baseState({ dueAt: '' }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body.due_at).toBeUndefined();
    }
  });

  it('encodes due_at as UTC midnight of the picked calendar date', () => {
    const result = buildCreatePaymentRequestBody(ISSUER_DID, baseState({ dueAt: '2026-03-01' }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body.due_at).toBe('2026-03-01T00:00:00.000Z');
    }
  });

  it('rejects a due date that is not a real calendar date instead of throwing', () => {
    const result = buildCreatePaymentRequestBody(ISSUER_DID, baseState({ dueAt: '2026-02-31' }));
    expect(result).toEqual({ ok: false, error: 'Due date must be a valid date' });
  });

  describe('in a negative-UTC-offset zone (#2651)', () => {
    beforeAll(() => {
      vi.stubEnv('TZ', 'America/Toronto');
    });
    afterAll(() => {
      vi.unstubAllEnvs();
    });

    it('sends the entered date, not the previous day', () => {
      expect(new Date('2026-10-06T12:00:00Z').getTimezoneOffset()).toBeGreaterThan(0);
      const result = buildCreatePaymentRequestBody(ISSUER_DID, baseState({ dueAt: '2026-10-06' }));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.body.due_at).toBe('2026-10-06T00:00:00.000Z');
        expect(String(result.body.due_at).slice(0, 10)).toBe('2026-10-06');
      }
    });
  });

  it('carries kind, currency, allow_on_platform, and issuer_did through as-is', () => {
    const result = buildCreatePaymentRequestBody(ISSUER_DID, baseState({ kind: 'request', currency: 'USD', allowOnPlatform: false }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body).toMatchObject({
        issuer_did: ISSUER_DID,
        kind: 'request',
        currency: 'USD',
        allow_on_platform: false,
      });
    }
  });
});

describe('buildCreatePaymentRequestBody — tax (#2421)', () => {
  function taxRow(overrides: Partial<TaxRowDraft> = {}): TaxRowDraft {
    return { key: 'CA-ON|GST/HST|123', jurisdiction: 'CA-ON', kind: 'GST/HST', number: '123456789RT0001', included: true, rate: '13', ...overrides };
  }

  it('with Charge tax off the body carries no tax fields at all — identical to pre-tax bodies', () => {
    const result = buildCreatePaymentRequestBody(ISSUER_DID, baseState({ chargeTax: false, taxRows: [taxRow()] }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      for (const field of ['charge_tax', 'taxes', 'subtotal_amount', 'tax_total_amount', 'total_amount']) {
        expect(result.body).not.toHaveProperty(field);
      }
    }
  });

  it('with Charge tax on: charge_tax, taxes[] and the previewed amounts (integer minor units)', () => {
    const result = buildCreatePaymentRequestBody(
      ISSUER_DID,
      baseState({ chargeTax: true, taxRows: [taxRow()], lineItems: [lineItem({ unitAmount: '19.99', quantity: '3' })] }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      // subtotal 5997; 13% = 779.61 -> 780; total 6777.
      expect(result.body).toMatchObject({
        charge_tax: true,
        taxes: [{ jurisdiction: 'CA-ON', kind: 'GST/HST', rate_bps: 1300, amount: 780 }],
        subtotal_amount: 5997,
        tax_total_amount: 780,
        total_amount: 6777,
      });
    }
  });

  it('one taxes[] row per CHARGED registration', () => {
    const result = buildCreatePaymentRequestBody(
      ISSUER_DID,
      baseState({
        chargeTax: true,
        lineItems: [lineItem({ unitAmount: '100.00' })],
        taxRows: [
          taxRow({ key: 'a', jurisdiction: 'CA-BC', kind: 'GST/HST', rate: '5' }),
          taxRow({ key: 'b', jurisdiction: 'CA-BC', kind: 'PST', rate: '7' }),
          taxRow({ key: 'c', jurisdiction: 'CA-QC', kind: 'QST', rate: '', included: false }),
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body.taxes as unknown[]).toHaveLength(2);
      expect(result.body).toMatchObject({ subtotal_amount: 10_000, tax_total_amount: 1200, total_amount: 11_200 });
    }
  });

  it('a blank rate on a charged registration is an error (required when the toggle is on)', () => {
    const result = buildCreatePaymentRequestBody(ISSUER_DID, baseState({ chargeTax: true, taxRows: [taxRow({ rate: '  ' })] }));
    expect(result).toEqual({ ok: false, error: 'Enter a rate for GST/HST (CA-ON)' });
  });

  it('a rate that is not a whole number of bps (9.975%) is refused, never rounded', () => {
    const result = buildCreatePaymentRequestBody(
      ISSUER_DID,
      baseState({ chargeTax: true, taxRows: [taxRow({ kind: 'QST', jurisdiction: 'CA-QC', rate: '9.975' })] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/QST \(CA-QC\): .*not a whole number of basis points/);
  });

  it('Charge tax on with no registration ticked is an error', () => {
    const result = buildCreatePaymentRequestBody(ISSUER_DID, baseState({ chargeTax: true, taxRows: [taxRow({ included: false })] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Pick at least one tax registration/);
  });

  it('zero rate: a 0 tax amount and total == subtotal', () => {
    const result = buildCreatePaymentRequestBody(ISSUER_DID, baseState({ chargeTax: true, taxRows: [taxRow({ rate: '0' })] }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.body).toMatchObject({ tax_total_amount: 0, subtotal_amount: 1999, total_amount: 1999 });
  });

  it('never sends the registration number', () => {
    const result = buildCreatePaymentRequestBody(ISSUER_DID, baseState({ chargeTax: true, taxRows: [taxRow()] }));
    expect(JSON.stringify(result)).not.toContain('123456789RT0001');
  });

  it('line-item errors still win over tax errors', () => {
    const result = buildCreatePaymentRequestBody(ISSUER_DID, baseState({ chargeTax: true, taxRows: [], lineItems: [lineItem({ name: '' })] }));
    expect(result).toEqual({ ok: false, error: 'Line item 1 needs a name' });
  });
});

describe('previewSubtotal', () => {
  it('sums amount × quantity in minor units', () => {
    expect(previewSubtotal([lineItem({ unitAmount: '19.99', quantity: '3' }), lineItem({ unitAmount: '0.01' })], 'CAD')).toBe(5998);
  });
  it('is null while any line item is incomplete', () => {
    expect(previewSubtotal([lineItem({ unitAmount: '' })], 'CAD')).toBeNull();
    expect(previewSubtotal([], 'CAD')).toBeNull();
  });
});
