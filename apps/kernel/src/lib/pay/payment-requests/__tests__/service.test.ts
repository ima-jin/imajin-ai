/**
 * Tests for the `pay.payment_request` service module: validation, issuer-only
 * enforcement, status-transition/idempotency rules, and attestation/bus
 * side-effects. `manifest.ts` / `content-hash.ts` run for real (pure,
 * deterministic) — only the DB, bus, id generator, and attestation emitter
 * are mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  insertCalls: [] as Array<Record<string, unknown>>,
  insertReturningQueue: [] as Array<Record<string, unknown>[]>,
  updateCalls: [] as Array<{ values: Record<string, unknown> }>,
  updateReturningQueue: [] as Array<Record<string, unknown>[]>,
  selectQueue: [] as Array<Record<string, unknown>[]>,
  publishMock: vi.fn().mockResolvedValue(undefined),
  issuedAttestationMock: vi.fn().mockResolvedValue('att_issued_1'),
  settledAttestationMock: vi.fn().mockResolvedValue('att_settled_1'),
  isConnectedMock: vi.fn().mockResolvedValue(true),
  createInviteMock: vi.fn(),
}));

function selectLimitResult() {
  return Promise.resolve(state.selectQueue.shift() ?? []);
}

function whereResult() {
  return { limit: selectLimitResult, orderBy: () => ({ limit: selectLimitResult }) };
}

function insertReturning(values: Record<string, unknown>) {
  return Promise.resolve(
    state.insertReturningQueue.shift() ?? [
      { ...values, createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z') },
    ],
  );
}

function insertValues(values: Record<string, unknown>) {
  state.insertCalls.push(values);
  return { returning: () => insertReturning(values) };
}

function updateReturning() {
  return Promise.resolve(state.updateReturningQueue.shift() ?? []);
}

function updateWhere(values: Record<string, unknown>) {
  state.updateCalls.push({ values });
  return { returning: updateReturning };
}

vi.mock('@/src/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: whereResult }) }),
    insert: () => ({ values: insertValues }),
    update: () => ({ set: (values: Record<string, unknown>) => ({ where: () => updateWhere(values) }) }),
  },
  paymentRequests: { __table: 'payment_request' },
  profiles: { __table: 'profiles' },
}));

vi.mock('@imajin/bus', () => ({ publish: state.publishMock }));

vi.mock('@/src/lib/kernel/id', () => ({ generateId: (prefix: string) => `${prefix}_test` }));

vi.mock('../attestations', () => ({
  emitPaymentRequestIssuedAttestation: state.issuedAttestationMock,
  emitPaymentRequestSettledAttestation: state.settledAttestationMock,
}));

vi.mock('@/src/lib/chat/connection-check', () => ({ isConnected: state.isConnectedMock }));

vi.mock('@/src/lib/connections/payment-request-invite', () => ({ createPaymentRequestInvite: state.createInviteMock }));

import {
  createPaymentRequest,
  getPaymentRequestByHandle,
  isServiceError,
  listPaymentRequests,
  settlePaymentRequestManual,
  voidPaymentRequest,
} from '../service';

const ISSUER_DID = 'did:imajin:issuer';
const RECIPIENT_DID = 'did:imajin:recipient';

const VALID_LINE_ITEMS = [{ name: 'Consulting', amount: 5000, quantity: 1 }];

function resetState() {
  for (const value of Object.values(state)) {
    if (Array.isArray(value)) value.length = 0;
  }
  state.publishMock.mockClear();
  state.issuedAttestationMock.mockClear();
  state.settledAttestationMock.mockClear();
  state.issuedAttestationMock.mockResolvedValue('att_issued_1');
  state.settledAttestationMock.mockResolvedValue('att_settled_1');
  state.isConnectedMock.mockReset();
  state.isConnectedMock.mockResolvedValue(true);
  state.createInviteMock.mockReset();
  state.createInviteMock.mockResolvedValue({
    recipientStubId: 'did:imajin:new-stub',
    inviteId: 'inv_1',
    inviteCode: 'code123',
    inviteUrl: 'https://jin.imajin.ai/connections/invite/did:imajin:issuer/code123',
  });
}

beforeEach(() => {
  resetState();
});

describe('createPaymentRequest', () => {
  it('rejects when issuer_did is missing', async () => {
    const result = await createPaymentRequest({ callerDid: ISSUER_DID, issuerDid: undefined, recipientDid: RECIPIENT_DID, lineItems: VALID_LINE_ITEMS });
    expect(isServiceError(result)).toBe(true);
    if (isServiceError(result)) expect(result.status).toBe(400);
  });

  it('rejects when the caller does not resolve to issuer_did (issuer-only)', async () => {
    const result = await createPaymentRequest({
      callerDid: 'did:imajin:someone-else',
      issuerDid: ISSUER_DID,
      recipientDid: RECIPIENT_DID,
      lineItems: VALID_LINE_ITEMS,
    });
    expect(isServiceError(result)).toBe(true);
    if (isServiceError(result)) expect(result.status).toBe(403);
    expect(state.insertCalls).toHaveLength(0);
  });

  it('rejects when both recipient_did and recipient_stub_id are supplied', async () => {
    const result = await createPaymentRequest({
      callerDid: ISSUER_DID,
      issuerDid: ISSUER_DID,
      recipientDid: RECIPIENT_DID,
      recipientStubId: 'stub_1',
      lineItems: VALID_LINE_ITEMS,
    });
    expect(isServiceError(result)).toBe(true);
    if (isServiceError(result)) expect(result.status).toBe(400);
  });

  it('rejects when neither recipient_did nor recipient_stub_id is supplied', async () => {
    const result = await createPaymentRequest({ callerDid: ISSUER_DID, issuerDid: ISSUER_DID, lineItems: VALID_LINE_ITEMS });
    expect(isServiceError(result)).toBe(true);
    if (isServiceError(result)) expect(result.status).toBe(400);
  });

  it('rejects an empty line_items array', async () => {
    const result = await createPaymentRequest({ callerDid: ISSUER_DID, issuerDid: ISSUER_DID, recipientDid: RECIPIENT_DID, lineItems: [] });
    expect(isServiceError(result)).toBe(true);
    if (isServiceError(result)) expect(result.status).toBe(400);
  });

  it('rejects a line item with a non-positive amount', async () => {
    const result = await createPaymentRequest({
      callerDid: ISSUER_DID,
      issuerDid: ISSUER_DID,
      recipientDid: RECIPIENT_DID,
      lineItems: [{ name: 'Bad', amount: 0, quantity: 1 }],
    });
    expect(isServiceError(result)).toBe(true);
    if (isServiceError(result)) expect(result.status).toBe(400);
  });

  it('creates with no caller-supplied manifest: persists a default single-payee manifest and computes the total', async () => {
    const result = await createPaymentRequest({
      callerDid: ISSUER_DID,
      issuerDid: ISSUER_DID,
      recipientDid: RECIPIENT_DID,
      lineItems: [
        { name: 'Item A', amount: 1000, quantity: 2 },
        { name: 'Item B', amount: 500, quantity: 1 },
      ],
    });

    expect(isServiceError(result)).toBe(false);
    expect(state.insertCalls).toHaveLength(1);
    const inserted = state.insertCalls[0];
    expect(inserted.totalAmount).toBe(2500); // 1000*2 + 500*1
    expect(inserted.fairManifest).toBeTruthy();
    expect((inserted.fairManifest as { total: { amount: number } }).total.amount).toBe(2500);
    expect(inserted.status).toBe('issued');
    expect(inserted.kind).toBe('invoice');

    // Exactly one issued attestation, and the bus event fired.
    expect(state.issuedAttestationMock).toHaveBeenCalledOnce();
    expect(state.publishMock).toHaveBeenCalledWith(
      'payment_request.issued',
      expect.objectContaining({ issuer: ISSUER_DID, subject: RECIPIENT_DID }),
    );
  });

  it('rejects a caller-supplied fair_manifest whose total does not match the computed request total', async () => {
    const result = await createPaymentRequest({
      callerDid: ISSUER_DID,
      issuerDid: ISSUER_DID,
      recipientDid: RECIPIENT_DID,
      lineItems: VALID_LINE_ITEMS,
      currency: 'CAD',
      fairManifest: { chain: [], total: { amount: 1, currency: 'CAD' } },
    });
    expect(isServiceError(result)).toBe(true);
    if (isServiceError(result)) expect(result.status).toBe(400);
    expect(state.insertCalls).toHaveLength(0);
  });

  it('accepts a caller-supplied fair_manifest whose total matches the computed request total', async () => {
    const result = await createPaymentRequest({
      callerDid: ISSUER_DID,
      issuerDid: ISSUER_DID,
      recipientDid: RECIPIENT_DID,
      lineItems: VALID_LINE_ITEMS,
      currency: 'CAD',
      fairManifest: { chain: [{ did: ISSUER_DID, role: 'seller', amount: 5000 }], total: { amount: 5000, currency: 'CAD' } },
    });
    expect(isServiceError(result)).toBe(false);
    expect(state.insertCalls).toHaveLength(1);
    expect(state.insertCalls[0].fairManifest).toEqual({
      chain: [{ did: ISSUER_DID, role: 'seller', amount: 5000 }],
      total: { amount: 5000, currency: 'CAD' },
    });
  });
});

describe('createPaymentRequest — recipient resolution (#2210)', () => {
  it('creates when recipient_did is an existing connection of the issuer', async () => {
    state.isConnectedMock.mockResolvedValue(true);
    const result = await createPaymentRequest({
      callerDid: ISSUER_DID,
      issuerDid: ISSUER_DID,
      recipientDid: RECIPIENT_DID,
      lineItems: VALID_LINE_ITEMS,
    });
    expect(isServiceError(result)).toBe(false);
    expect(state.isConnectedMock).toHaveBeenCalledWith(ISSUER_DID, RECIPIENT_DID);
  });

  it('rejects recipient_did when the issuer has no existing connection with it (403)', async () => {
    state.isConnectedMock.mockResolvedValue(false);
    const result = await createPaymentRequest({
      callerDid: ISSUER_DID,
      issuerDid: ISSUER_DID,
      recipientDid: RECIPIENT_DID,
      lineItems: VALID_LINE_ITEMS,
    });
    expect(isServiceError(result)).toBe(true);
    if (isServiceError(result)) expect(result.status).toBe(403);
    expect(state.insertCalls).toHaveLength(0);
  });

  it('rejects recipient_invite without an email', async () => {
    const result = await createPaymentRequest({
      callerDid: ISSUER_DID,
      issuerDid: ISSUER_DID,
      recipientInvite: { delivery: 'email' },
      lineItems: VALID_LINE_ITEMS,
    });
    expect(isServiceError(result)).toBe(true);
    if (isServiceError(result)) expect(result.status).toBe(400);
    expect(state.createInviteMock).not.toHaveBeenCalled();
  });

  it('rejects when recipient_did AND recipient_invite are both supplied', async () => {
    const result = await createPaymentRequest({
      callerDid: ISSUER_DID,
      issuerDid: ISSUER_DID,
      recipientDid: RECIPIENT_DID,
      recipientInvite: { email: 'customer@example.com' },
      lineItems: VALID_LINE_ITEMS,
    });
    expect(isServiceError(result)).toBe(true);
    if (isServiceError(result)) expect(result.status).toBe(400);
  });

  it('creates via recipient_invite: creates-or-reuses the stub + invite carrying this request as the opaque reason, and returns the invite handle', async () => {
    const result = await createPaymentRequest({
      callerDid: ISSUER_DID,
      issuerDid: ISSUER_DID,
      recipientInvite: { email: 'customer@example.com', delivery: 'email', note: 'thanks!' },
      lineItems: VALID_LINE_ITEMS,
    });

    expect(isServiceError(result)).toBe(false);
    expect(state.createInviteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        issuerDid: ISSUER_DID,
        email: 'customer@example.com',
        delivery: 'email',
        note: 'thanks!',
        reasonContextType: 'payment_request',
      }),
    );
    // reasonContextId is the payment_request's own generated id.
    const inviteCallArg = state.createInviteMock.mock.calls[0][0];
    expect(typeof inviteCallArg.reasonContextId).toBe('string');
    expect(inviteCallArg.reasonContextId).toBeTruthy();

    expect(state.insertCalls).toHaveLength(1);
    expect(state.insertCalls[0].recipientStubId).toBe('did:imajin:new-stub');
    expect(state.insertCalls[0].recipientDid).toBeNull();

    if (!isServiceError(result)) {
      expect(result.invite).toEqual({ id: 'inv_1', code: 'code123', url: 'https://jin.imajin.ai/connections/invite/did:imajin:issuer/code123' });
    }
  });

  it('every created payment_request gets an opaque pay_handle', async () => {
    const result = await createPaymentRequest({
      callerDid: ISSUER_DID,
      issuerDid: ISSUER_DID,
      recipientDid: RECIPIENT_DID,
      lineItems: VALID_LINE_ITEMS,
    });
    expect(isServiceError(result)).toBe(false);
    expect(state.insertCalls[0].payHandle).toBeTruthy();
  });
});

describe('getPaymentRequestByHandle (#2210)', () => {
  const ROW = {
    id: 'pr_1',
    kind: 'invoice',
    issuerDid: ISSUER_DID,
    lineItems: VALID_LINE_ITEMS,
    totalAmount: 5000,
    currency: 'CAD',
    status: 'issued',
    payHandle: 'ph_abc',
  };

  it('returns null (404 at the route layer) for an unknown handle', async () => {
    state.selectQueue.push([]);
    const result = await getPaymentRequestByHandle('ph_bad');
    expect(result).toBeNull();
  });

  it('returns the minimum-necessary view for a known handle — no issuer DID, no recipient fields, no content_hash', async () => {
    state.selectQueue.push([ROW]);
    state.selectQueue.push([{ displayName: 'Acme Co', handle: 'acme' }]);

    const result = await getPaymentRequestByHandle('ph_abc');

    expect(result).toEqual({
      kind: 'invoice',
      lineItems: VALID_LINE_ITEMS,
      totalAmount: 5000,
      currency: 'CAD',
      issuerDisplayName: 'Acme Co',
      status: 'issued',
    });
    expect(result).not.toHaveProperty('issuerDid');
    expect(result).not.toHaveProperty('recipientDid');
    expect(result).not.toHaveProperty('recipientStubId');
    expect(result).not.toHaveProperty('contentHash');
    expect(result).not.toHaveProperty('fairManifest');
  });

  it('is hidden (null) once void, same as an unknown handle', async () => {
    state.selectQueue.push([{ ...ROW, status: 'void' }]);
    const result = await getPaymentRequestByHandle('ph_abc');
    expect(result).toBeNull();
  });

  it('falls back to a truncated DID when the issuer has no profile', async () => {
    state.selectQueue.push([ROW]);
    state.selectQueue.push([]);

    const result = await getPaymentRequestByHandle('ph_abc');
    expect(result?.issuerDisplayName).toBe(ISSUER_DID.slice(0, 16));
  });

  it('pay-first ordering: the handle view is identical whether the row is still addressed to an unclaimed recipient_stub_id or already resolved to recipient_did', async () => {
    const STUB_ADDRESSED = { ...ROW, recipientDid: null, recipientStubId: 'did:imajin:unclaimed-stub' };
    const DID_RESOLVED = { ...ROW, recipientDid: 'did:imajin:unclaimed-stub', recipientStubId: null };

    state.selectQueue.push([STUB_ADDRESSED]);
    state.selectQueue.push([{ displayName: 'Acme Co' }]);
    const beforeClaim = await getPaymentRequestByHandle('ph_abc');

    state.selectQueue.push([DID_RESOLVED]);
    state.selectQueue.push([{ displayName: 'Acme Co' }]);
    const afterClaim = await getPaymentRequestByHandle('ph_abc');

    // The payer-facing view never varies with recipient_did/recipient_stub_id
    // state — the request stays payable through the same handle regardless
    // of whether the recipient has claimed yet.
    expect(beforeClaim).toEqual(afterClaim);
  });
});

describe('listPaymentRequests', () => {
  it('queries with the supplied filters and returns rows', async () => {
    state.selectQueue.push([{ id: 'pr_1' }]);
    const rows = await listPaymentRequests({ issuerDid: ISSUER_DID });
    expect(rows).toEqual([{ id: 'pr_1' }]);
  });
});

describe('voidPaymentRequest', () => {
  it('returns 404 when not found', async () => {
    state.selectQueue.push([]);
    const result = await voidPaymentRequest({ id: 'pr_missing', callerDid: ISSUER_DID });
    expect(isServiceError(result)).toBe(true);
    if (isServiceError(result)) expect(result.status).toBe(404);
  });

  it('returns 403 when the caller is not the issuer', async () => {
    state.selectQueue.push([{ id: 'pr_1', issuerDid: ISSUER_DID, status: 'issued', recipientDid: RECIPIENT_DID }]);
    const result = await voidPaymentRequest({ id: 'pr_1', callerDid: RECIPIENT_DID });
    expect(isServiceError(result)).toBe(true);
    if (isServiceError(result)) expect(result.status).toBe(403);
  });

  it('returns 409 when the request is not in issued status', async () => {
    state.selectQueue.push([{ id: 'pr_1', issuerDid: ISSUER_DID, status: 'void', recipientDid: RECIPIENT_DID }]);
    const result = await voidPaymentRequest({ id: 'pr_1', callerDid: ISSUER_DID });
    expect(isServiceError(result)).toBe(true);
    if (isServiceError(result)) expect(result.status).toBe(409);
    expect(state.updateCalls).toHaveLength(0);
  });

  it('voids an issued request and publishes payment_request.voided', async () => {
    state.selectQueue.push([{ id: 'pr_1', issuerDid: ISSUER_DID, status: 'issued', recipientDid: RECIPIENT_DID }]);
    state.updateReturningQueue.push([{ id: 'pr_1', issuerDid: ISSUER_DID, status: 'void', recipientDid: RECIPIENT_DID }]);

    const result = await voidPaymentRequest({ id: 'pr_1', callerDid: ISSUER_DID });
    expect(isServiceError(result)).toBe(false);
    expect(state.publishMock).toHaveBeenCalledWith('payment_request.voided', expect.objectContaining({ issuer: ISSUER_DID }));
  });

  it('rejects an idempotent replay cleanly (409) once already void', async () => {
    state.selectQueue.push([{ id: 'pr_1', issuerDid: ISSUER_DID, status: 'void', recipientDid: RECIPIENT_DID }]);
    const result = await voidPaymentRequest({ id: 'pr_1', callerDid: ISSUER_DID });
    expect(isServiceError(result)).toBe(true);
    if (isServiceError(result)) expect(result.status).toBe(409);
  });
});

describe('settlePaymentRequestManual', () => {
  const issuedRow = { id: 'pr_1', issuerDid: ISSUER_DID, recipientDid: RECIPIENT_DID, status: 'issued', contentHash: 'bafy-x', totalAmount: 5000, currency: 'CAD' };

  it('returns 404 when not found', async () => {
    state.selectQueue.push([]);
    const result = await settlePaymentRequestManual({ id: 'pr_missing', callerDid: ISSUER_DID });
    expect(isServiceError(result)).toBe(true);
    if (isServiceError(result)) expect(result.status).toBe(404);
  });

  it('returns 403 when the caller is not the issuer', async () => {
    state.selectQueue.push([issuedRow]);
    const result = await settlePaymentRequestManual({ id: 'pr_1', callerDid: RECIPIENT_DID });
    expect(isServiceError(result)).toBe(true);
    if (isServiceError(result)) expect(result.status).toBe(403);
  });

  it('settles an issued request, records settlement_ref, mints exactly one attestation, and publishes', async () => {
    state.selectQueue.push([issuedRow]);
    state.updateReturningQueue.push([{ ...issuedRow, status: 'settled_manual' }]);

    const result = await settlePaymentRequestManual({ id: 'pr_1', callerDid: ISSUER_DID, note: 'e-transfer sent' });
    expect(isServiceError(result)).toBe(false);

    const updateValues = state.updateCalls[0].values;
    expect(updateValues.status).toBe('settled_manual');
    expect((updateValues.settlementRef as Record<string, unknown>).method).toBe('manual');
    expect((updateValues.settlementRef as Record<string, unknown>).asserted_by).toBe(ISSUER_DID);
    expect((updateValues.settlementRef as Record<string, unknown>).note).toBe('e-transfer sent');

    expect(state.settledAttestationMock).toHaveBeenCalledOnce();
    expect(state.publishMock).toHaveBeenCalledWith(
      'payment_request.settled',
      expect.objectContaining({ payload: expect.objectContaining({ method: 'manual' }) }),
    );
  });

  it('rejects settling an already settled_manual request cleanly (idempotent replay -> 409)', async () => {
    state.selectQueue.push([{ ...issuedRow, status: 'settled_manual' }]);
    const result = await settlePaymentRequestManual({ id: 'pr_1', callerDid: ISSUER_DID });
    expect(isServiceError(result)).toBe(true);
    if (isServiceError(result)) expect(result.status).toBe(409);
    expect(state.updateCalls).toHaveLength(0);
  });

  it('rejects settling a void request (409)', async () => {
    state.selectQueue.push([{ ...issuedRow, status: 'void' }]);
    const result = await settlePaymentRequestManual({ id: 'pr_1', callerDid: ISSUER_DID });
    expect(isServiceError(result)).toBe(true);
    if (isServiceError(result)) expect(result.status).toBe(409);
  });
});
