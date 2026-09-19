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

import {
  emitPaymentRequestIssuedAttestation,
  emitPaymentRequestSettledAttestation,
} from '../attestations';

const ISSUER_DID = 'did:imajin:issuer';
const RECIPIENT_DID = 'did:imajin:recipient';

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AUTH_PRIVATE_KEY = 'test-private-key';
  mocks.signSyncMock.mockReturnValue('sig');
  mocks.computeCidMock.mockResolvedValue('bafy-test');
  mocks.insertValuesMock.mockResolvedValue(undefined);
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
