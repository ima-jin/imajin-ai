/**
 * Pure e-Transfer offer logic (#2665): when the option appears, and what the
 * payer is told to send.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/src/db', () => ({ db: {}, balances: {}, transactions: {}, withdrawalIntents: {} }));

import { emtInstructionsFor, emtMemoOf, emtOptionOf, toEmtInstructionsView } from '../emt-offer';

const REQUEST = {
  kind: 'invoice' as const,
  id: 'pr_3f9a1c07d2aabbccddeeff00',
  totalAmount: 11_300,
  currency: 'CAD',
  allowOnPlatform: true,
  status: 'issued',
};

describe('emtMemoOf', () => {
  it('is the request-unique document number, never the full internal id', () => {
    expect(emtMemoOf(REQUEST)).toBe('INV-3F9A1C07D2');
    expect(emtMemoOf({ kind: 'request', id: 'pr_3f9a1c07d2aabbccddeeff00' })).toBe('REQ-3F9A1C07D2');
    expect(emtMemoOf(REQUEST)).not.toContain('aabbccddeeff00');
  });

  it('differs for two different requests', () => {
    expect(emtMemoOf(REQUEST)).not.toBe(emtMemoOf({ kind: 'invoice', id: 'pr_aaaaaaaaaabbccddeeff00' }));
  });
});

describe('emtInstructionsFor', () => {
  it('builds instructions for the GRAND total (tax included), to the issuer email', () => {
    expect(emtInstructionsFor(REQUEST, 'pay@acme.example')).toEqual({
      rail: 'emt',
      destination: 'pay@acme.example',
      amountMinor: 11_300,
      currency: 'CAD',
      reference: 'INV-3F9A1C07D2',
    });
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty', ''],
    ['blank', '   '],
  ])('is null when the receiving email is %s', (_label, email) => {
    expect(emtInstructionsFor(REQUEST, email)).toBeNull();
  });

  it('is null for a non-CAD request (e-Transfer is CAD only)', () => {
    expect(emtInstructionsFor({ ...REQUEST, currency: 'USD' }, 'pay@acme.example')).toBeNull();
  });

  it('is null when the issuer does not allow on-platform payment', () => {
    expect(emtInstructionsFor({ ...REQUEST, allowOnPlatform: false }, 'pay@acme.example')).toBeNull();
  });
});

describe('toEmtInstructionsView', () => {
  it('maps rail-neutral instructions to the { email, amount, memo } shape the top-up route also uses', () => {
    expect(
      toEmtInstructionsView({ rail: 'emt', destination: 'pay@acme.example', amountMinor: 5000, currency: 'CAD', reference: 'INV-1' }),
    ).toEqual({ email: 'pay@acme.example', amountMinor: 5000, currency: 'CAD', memo: 'INV-1' });
  });
});

describe('emtOptionOf — the pay page option', () => {
  it('is available (without the email) for an open request when the issuer set an email', () => {
    expect(emtOptionOf(REQUEST, 'pay@acme.example')).toEqual({ state: 'available', instructions: null });
  });

  it('is pending, WITH the instructions, once the payer chose e-Transfer', () => {
    expect(emtOptionOf({ ...REQUEST, status: 'emt_pending' }, 'pay@acme.example')).toEqual({
      state: 'pending',
      instructions: { email: 'pay@acme.example', amountMinor: 11_300, currency: 'CAD', memo: 'INV-3F9A1C07D2' },
    });
  });

  it('does NOT appear without a receiving email', () => {
    expect(emtOptionOf(REQUEST, null)).toBeNull();
    expect(emtOptionOf({ ...REQUEST, status: 'emt_pending' }, '')).toBeNull();
  });

  it.each(['paid', 'settled_manual', 'void'])('does not appear once the request is %s', (status) => {
    expect(emtOptionOf({ ...REQUEST, status }, 'pay@acme.example')).toBeNull();
  });
});
