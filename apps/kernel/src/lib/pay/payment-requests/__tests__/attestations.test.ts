/**
 * Tests for the payment_request attestation helper — mirrors the mocking
 * shape of `emit-mechanical-attestation.test.ts`, but asserts `issuerDid`
 * is the CALLER-supplied DID (the payment_request's issuer), never a
 * platform/node DID, since that is the whole point of this module.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
  const insertValuesMock = vi.fn().mockResolvedValue(undefined);
  const insertMock = vi.fn(() => ({ values: insertValuesMock }));
  const signSyncMock = vi.fn().mockReturnValue('sig');
  const computeCidMock = vi.fn().mockResolvedValue('bafy-test');
  return { insertValuesMock, insertMock, signSyncMock, computeCidMock };
});

vi.mock('@/src/db', () => ({
  db: { insert: mocks.insertMock },
  attestations: {},
}));

vi.mock('@imajin/auth', () => ({
  canonicalize: (v: unknown) => JSON.stringify(v),
  crypto: { signSync: mocks.signSyncMock },
}));

vi.mock('@imajin/cid', () => ({ computeCid: mocks.computeCidMock }));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

// #2209: `attestations.ts` now also imports `emitMechanicalAttestation` (for
// the kernel-signed stripe-settled path), which transitively pulls in
// `node-identity.ts` — mocked here so its module-scope `getClient()` call
// never runs against a real (absent in tests) DATABASE_URL, matching
// `emit-mechanical-attestation.test.ts`'s own mocking of this module.
vi.mock('@/src/lib/kernel/node-identity', () => ({
  getNodeDid: vi.fn().mockResolvedValue('did:imajin:node'),
}));

const mechanicalMock = vi.hoisted(() => vi.fn().mockResolvedValue('att_mech_1'));
vi.mock('@/src/lib/auth/emit-mechanical-attestation', () => ({
  emitMechanicalAttestation: mechanicalMock,
}));

import {
  emitPaymentRequestIssuedAttestation,
  emitPaymentRequestSettledAttestation,
  emitPaymentRequestSettledStripeAttestation,
} from '../attestations';

const ISSUER_DID = 'did:imajin:issuer';
const RECIPIENT_DID = 'did:imajin:recipient';

/** #2421 — $100.00 subtotal + 13% GST/HST. */
const TAX_BREAKDOWN = {
  subtotalAmount: 10_000,
  taxTotalAmount: 1300,
  taxes: [
    { jurisdiction: 'CA-ON', kind: 'GST/HST', rateBps: 1300, amount: 1300, registrationNumber: '123456789RT0001' },
  ],
};
const TAX_PAYLOAD_FIELDS = {
  subtotal_amount: 10_000,
  tax_total_amount: 1300,
  taxes: [
    { jurisdiction: 'CA-ON', kind: 'GST/HST', rate_bps: 1300, amount: 1300, registration_number: '123456789RT0001' },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AUTH_PRIVATE_KEY = 'test-private-key';
  mocks.signSyncMock.mockReturnValue('sig');
  mocks.computeCidMock.mockResolvedValue('bafy-test');
  mocks.insertValuesMock.mockResolvedValue(undefined);
});

describe('emitPaymentRequestSettledAttestation — e-Transfer (#2665)', () => {
  const base = {
    paymentRequestId: 'pr_1',
    issuerDid: ISSUER_DID,
    recipientDid: RECIPIENT_DID,
    assertedBy: ISSUER_DID,
    contentHash: 'bafy-content',
    totalAmount: 5000,
    currency: 'CAD',
  };

  it('names the rail in the payload and records the memo it was matched against, signed by the issuer', async () => {
    await emitPaymentRequestSettledAttestation({ ...base, method: 'emt', reference: 'INV-0123456789' });

    const inserted = mocks.insertValuesMock.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted.issuerDid).toBe(ISSUER_DID);
    expect(inserted.type).toBe('payment_request.settled');
    expect(inserted.payload).toMatchObject({
      method: 'emt',
      asserted_by: ISSUER_DID,
      reference: 'INV-0123456789',
      total_amount: 5000,
      content_hash: 'bafy-content',
    });
  });

  it('leaves the payload byte-identical for a settlement with no reference (manual) — no reference key at all', async () => {
    await emitPaymentRequestSettledAttestation({ ...base, method: 'manual' });

    const payload = (mocks.insertValuesMock.mock.calls[0][0] as { payload: Record<string, unknown> }).payload;
    expect('reference' in payload).toBe(false);
  });
});

describe('emitPaymentRequestIssuedAttestation', () => {
  it('records issuerDid as the payment_request issuer, never a platform DID', async () => {
    await emitPaymentRequestIssuedAttestation({
      paymentRequestId: 'pr_1',
      issuerDid: ISSUER_DID,
      recipientDid: RECIPIENT_DID,
      recipientStubId: null,
      kind: 'invoice',
      totalAmount: 5000,
      currency: 'CAD',
      contentHash: 'bafy-content',
    });

    expect(mocks.insertValuesMock).toHaveBeenCalledOnce();
    const inserted = mocks.insertValuesMock.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted.issuerDid).toBe(ISSUER_DID);
    expect(inserted.subjectDid).toBe(RECIPIENT_DID);
    expect(inserted.type).toBe('payment_request.issued');
    expect(inserted.contextId).toBe('pr_1');
    expect(inserted.contextType).toBe('payment_request');
    expect(inserted.attestationStatus).toBeNull();
    expect((inserted.payload as Record<string, unknown>).content_hash).toBe('bafy-content');
  });

  it('falls back subjectDid to the issuer when no recipient DID is known yet (claimable-stub recipient)', async () => {
    await emitPaymentRequestIssuedAttestation({
      paymentRequestId: 'pr_2',
      issuerDid: ISSUER_DID,
      recipientDid: null,
      recipientStubId: 'stub_1',
      kind: 'request',
      totalAmount: 100,
      currency: 'USD',
      contentHash: 'bafy-2',
    });

    const inserted = mocks.insertValuesMock.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted.subjectDid).toBe(ISSUER_DID);
    expect((inserted.payload as Record<string, unknown>).recipient_stub_id).toBe('stub_1');
  });

  it('returns null and skips the write when AUTH_PRIVATE_KEY is unset', async () => {
    delete process.env.AUTH_PRIVATE_KEY;
    const id = await emitPaymentRequestIssuedAttestation({
      paymentRequestId: 'pr_3',
      issuerDid: ISSUER_DID,
      recipientDid: RECIPIENT_DID,
      recipientStubId: null,
      kind: 'invoice',
      totalAmount: 100,
      currency: 'USD',
      contentHash: 'bafy-3',
    });
    expect(id).toBeNull();
    expect(mocks.insertValuesMock).not.toHaveBeenCalled();
  });
});

describe('emitPaymentRequestSettledAttestation', () => {
  it('records the settlement, signed by the asserting issuer, with method and asserted_by', async () => {
    await emitPaymentRequestSettledAttestation({
      paymentRequestId: 'pr_1',
      issuerDid: ISSUER_DID,
      recipientDid: RECIPIENT_DID,
      method: 'manual',
      assertedBy: ISSUER_DID,
      note: 'paid via e-transfer',
      contentHash: 'bafy-content',
      totalAmount: 5000,
      currency: 'CAD',
    });

    const inserted = mocks.insertValuesMock.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted.issuerDid).toBe(ISSUER_DID);
    expect(inserted.type).toBe('payment_request.settled');
    const payload = inserted.payload as Record<string, unknown>;
    expect(payload.method).toBe('manual');
    expect(payload.asserted_by).toBe(ISSUER_DID);
    expect(payload.note).toBe('paid via e-transfer');
  });
});

describe('tax breakdown in attestation payloads (#2421)', () => {
  const ISSUED = {
    paymentRequestId: 'pr_1',
    issuerDid: ISSUER_DID,
    recipientDid: RECIPIENT_DID,
    recipientStubId: null,
    kind: 'invoice',
    totalAmount: 11_300,
    currency: 'CAD',
    contentHash: 'bafy-content',
  };
  const SETTLED = {
    paymentRequestId: 'pr_1',
    issuerDid: ISSUER_DID,
    recipientDid: RECIPIENT_DID,
    method: 'manual' as const,
    assertedBy: ISSUER_DID,
    contentHash: 'bafy-content',
    totalAmount: 11_300,
    currency: 'CAD',
  };
  const payloadOf = () => (mocks.insertValuesMock.mock.calls[0][0] as { payload: Record<string, unknown> }).payload;

  it('issued: carries subtotal / tax_total / per-line taxes next to the grand total_amount', async () => {
    await emitPaymentRequestIssuedAttestation({ ...ISSUED, tax: TAX_BREAKDOWN });
    expect(payloadOf()).toMatchObject({ total_amount: 11_300, ...TAX_PAYLOAD_FIELDS });
    const p = payloadOf() as { subtotal_amount: number; tax_total_amount: number; total_amount: number };
    expect(p.subtotal_amount + p.tax_total_amount).toBe(p.total_amount);
  });

  it('manual settled receipt: carries the same breakdown', async () => {
    await emitPaymentRequestSettledAttestation({ ...SETTLED, tax: TAX_BREAKDOWN });
    expect(payloadOf()).toMatchObject({ total_amount: 11_300, ...TAX_PAYLOAD_FIELDS });
  });

  it('stripe settled receipt (kernel-signed): carries the same breakdown', async () => {
    await emitPaymentRequestSettledStripeAttestation({
      paymentRequestId: 'pr_1',
      issuerDid: ISSUER_DID,
      recipientDid: RECIPIENT_DID,
      contentHash: 'bafy-content',
      totalAmount: 11_300,
      currency: 'CAD',
      settlementRef: { method: 'stripe', settled_at: '2026-01-01T00:00:00Z', checkout_session_id: 'cs_1' },
      tax: TAX_BREAKDOWN,
    });
    const { payload } = mechanicalMock.mock.calls[0][0] as { payload: Record<string, unknown> };
    expect(payload).toMatchObject({ method: 'stripe', total_amount: 11_300, ...TAX_PAYLOAD_FIELDS });
  });

  it.each([
    ['null', null],
    ['omitted', undefined],
  ])('without tax (%s): the payload has none of the tax fields — identical to pre-#2421', async (_label, tax) => {
    await emitPaymentRequestIssuedAttestation({ ...ISSUED, totalAmount: 10_000, tax });
    const payload = payloadOf();
    expect(payload).not.toHaveProperty('subtotal_amount');
    expect(payload).not.toHaveProperty('tax_total_amount');
    expect(payload).not.toHaveProperty('taxes');
    expect(Object.keys(payload).sort()).toEqual(
      ['content_hash', 'currency', 'kind', 'payment_request_id', 'recipient_did', 'recipient_stub_id', 'total_amount'].sort(),
    );
  });
});
