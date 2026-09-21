import { describe, it, expect } from 'vitest';
import { buildCreatePaymentRequestBody, type CreateFormState } from '../build-create-request';
import type { LineItemDraft } from '../types';

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

  it('ISO-encodes due_at when set', () => {
    const result = buildCreatePaymentRequestBody(ISSUER_DID, baseState({ dueAt: '2026-03-01' }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body.due_at).toBe(new Date('2026-03-01').toISOString());
    }
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
