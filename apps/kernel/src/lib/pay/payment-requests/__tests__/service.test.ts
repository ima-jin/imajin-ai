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

const REG_ON = { jurisdiction: 'CA-ON', kind: 'GST/HST', number: '123456789RT0001' };
const REG_BC_PST = { jurisdiction: 'CA-BC', kind: 'PST', number: '12345678' };
const REG_BC_GST = { jurisdiction: 'CA-BC', kind: 'GST/HST', number: '987654321RT0001' };

/** A stored `taxes[]` row for a $50.00 subtotal at 13% (round(5000 × 1300 / 10000) = 650). */
const TAX_ROW_ON = {
  jurisdiction: 'CA-ON',
  kind: 'GST/HST',
  rateBps: 1300,
  basisAmount: 5000,
  amount: 650,
  registrationNumber: '123456789RT0001',
  collectorDid: ISSUER_DID,
  remitTo: 'did:imajin:authority:ca-cra',
};

const CHARGED_BASE = { callerDid: ISSUER_DID, issuerDid: ISSUER_DID, recipientDid: RECIPIENT_DID, lineItems: VALID_LINE_ITEMS };

/** Queue the issuer profile's tax registrations — consumed by the create path's registration lookup. */
function queueRegistrations(taxRegistrations: unknown[]) {
  state.selectQueue.push([{ taxRegistrations }]);
}

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

describe('createPaymentRequest — without tax (#2421 backward compatibility)', () => {
  it('stores subtotal = total, tax_total = 0, no taxes[], no fair stamp, and hands the attestation no breakdown', async () => {
    const result = await createPaymentRequest(CHARGED_BASE);
    expect(isServiceError(result)).toBe(false);

    const inserted = state.insertCalls[0];
    expect(inserted).toMatchObject({ totalAmount: 5000, subtotalAmount: 5000, taxTotalAmount: 0 });
    expect(inserted.fairManifest).not.toHaveProperty('taxes');
    expect(inserted.fairManifest).not.toHaveProperty('fair');
    expect(state.issuedAttestationMock.mock.calls[0][0].tax).toBeNull();
    // No profile read is needed (and none is made) when no tax is charged.
    expect(state.selectQueue).toHaveLength(0);
  });

  it('an explicit charge_tax: false with no taxes behaves exactly like omitting it', async () => {
    const result = await createPaymentRequest({ ...CHARGED_BASE, chargeTax: false, taxes: [] });
    expect(isServiceError(result)).toBe(false);
    expect(state.insertCalls[0]).toMatchObject({ totalAmount: 5000, subtotalAmount: 5000, taxTotalAmount: 0 });
  });
});

describe('createPaymentRequest — charge_tax (#2421)', () => {
  const ON_ROW = { jurisdiction: 'CA-ON', kind: 'GST/HST', rate_bps: 1300 };

  it('stores subtotal / tax_total / total with total = subtotal + tax_total, and a full FairTax row built from the issuer registration', async () => {
    queueRegistrations([REG_ON]);
    const result = await createPaymentRequest({ ...CHARGED_BASE, chargeTax: true, taxes: [ON_ROW] });
    expect(isServiceError(result)).toBe(false);

    const inserted = state.insertCalls[0];
    expect(inserted).toMatchObject({ subtotalAmount: 5000, taxTotalAmount: 650, totalAmount: 5650 });
    expect((inserted.subtotalAmount as number) + (inserted.taxTotalAmount as number)).toBe(inserted.totalAmount);

    const manifest = inserted.fairManifest as Record<string, unknown>;
    expect(manifest.taxes).toEqual([TAX_ROW_ON]);
    expect(manifest.fair).toBe('1.2');
    expect(manifest.version).toBe('0.5.0');
    // fair_manifest.total stays the PRE-TAX subtotal (the .fair basis).
    expect(manifest.total).toEqual({ amount: 5000, currency: 'CAD' });
  });

  it('carries the same breakdown on the issued attestation', async () => {
    queueRegistrations([REG_ON]);
    await createPaymentRequest({ ...CHARGED_BASE, chargeTax: true, taxes: [ON_ROW] });

    const args = state.issuedAttestationMock.mock.calls[0][0];
    expect(args.totalAmount).toBe(5650);
    expect(args.tax).toEqual({
      subtotalAmount: 5000,
      taxTotalAmount: 650,
      taxes: [{ jurisdiction: 'CA-ON', kind: 'GST/HST', rateBps: 1300, amount: 650, registrationNumber: '123456789RT0001' }],
    });
  });

  it('binds the tax breakdown into content_hash (a taxed and an untaxed request never hash alike)', async () => {
    await createPaymentRequest(CHARGED_BASE);
    queueRegistrations([REG_ON]);
    await createPaymentRequest({ ...CHARGED_BASE, chargeTax: true, taxes: [ON_ROW] });

    expect(state.insertCalls[0].contentHash).not.toBe(state.insertCalls[1].contentHash);
  });

  it('one taxes[] row per charged registration (GST + PST), each rounded independently, summed via packages/money', async () => {
    queueRegistrations([REG_BC_GST, REG_BC_PST]);
    const result = await createPaymentRequest({
      ...CHARGED_BASE,
      lineItems: [{ name: 'Build', amount: 10_001, quantity: 2 }], // $200.02
      chargeTax: true,
      taxes: [
        { jurisdiction: 'CA-BC', kind: 'GST/HST', rate_bps: 500 },
        { jurisdiction: 'CA-BC', kind: 'PST', rate_bps: 700 },
      ],
    });
    expect(isServiceError(result)).toBe(false);

    // 20002 × 5% = 1000.1 → 1000; 20002 × 7% = 1400.14 → 1400.
    const inserted = state.insertCalls[0];
    expect(inserted).toMatchObject({ subtotalAmount: 20_002, taxTotalAmount: 2400, totalAmount: 22_402 });
    const taxes = (inserted.fairManifest as { taxes: Array<Record<string, unknown>> }).taxes;
    expect(taxes).toHaveLength(2);
    expect(taxes.map((t) => [t.kind, t.amount, t.registrationNumber, t.remitTo])).toEqual([
      ['GST/HST', 1000, '987654321RT0001', 'did:imajin:authority:ca-cra'],
      ['PST', 1400, '12345678', 'did:imajin:authority:ca-bc'],
    ]);
    for (const t of taxes) expect(t.basisAmount).toBe(20_002);
  });

  it('rounds each row half up to the cent (round(basis × rateBps / 10000))', async () => {
    queueRegistrations([REG_ON]);
    await createPaymentRequest({
      ...CHARGED_BASE,
      lineItems: [{ name: 'Odd', amount: 1050, quantity: 1 }],
      chargeTax: true,
      taxes: [{ jurisdiction: 'CA-ON', kind: 'GST/HST', rate_bps: 500 }], // 52.5 → 53
    });
    expect(state.insertCalls[0]).toMatchObject({ taxTotalAmount: 53, totalAmount: 1103 });
  });

  it('zero tax (0% rate): the row is kept at amount 0 and total equals subtotal', async () => {
    queueRegistrations([REG_ON]);
    const result = await createPaymentRequest({
      ...CHARGED_BASE,
      chargeTax: true,
      taxes: [{ jurisdiction: 'CA-ON', kind: 'GST/HST', rate_bps: 0 }],
    });
    expect(isServiceError(result)).toBe(false);
    expect(state.insertCalls[0]).toMatchObject({ subtotalAmount: 5000, taxTotalAmount: 0, totalAmount: 5000 });
    expect((state.insertCalls[0].fairManifest as { taxes: unknown[] }).taxes).toHaveLength(1);
  });

  it('never trusts a client-supplied registration number — the issuer profile is authoritative', async () => {
    queueRegistrations([REG_ON]);
    await createPaymentRequest({
      ...CHARGED_BASE,
      chargeTax: true,
      taxes: [{ ...ON_ROW, registration_number: 'FORGED-000', registrationNumber: 'FORGED-000' }],
    });
    const taxes = (state.insertCalls[0].fairManifest as { taxes: Array<{ registrationNumber: string }> }).taxes;
    expect(taxes[0].registrationNumber).toBe('123456789RT0001');
  });

  it('accepts client-previewed amounts that match the server recomputation', async () => {
    queueRegistrations([REG_ON]);
    const result = await createPaymentRequest({
      ...CHARGED_BASE,
      chargeTax: true,
      taxes: [{ ...ON_ROW, amount: 650 }],
      subtotalAmount: 5000,
      taxTotalAmount: 650,
      totalAmount: 5650,
    });
    expect(isServiceError(result)).toBe(false);
  });

  describe.each([
    ['a wrong per-row tax amount', { taxes: [{ jurisdiction: 'CA-ON', kind: 'GST/HST', rate_bps: 1300, amount: 600 }] }, /taxes\[0\]\.amount \(600\).*recomputed.*\(650\)/],
    ['a wrong tax_total_amount', { taxTotalAmount: 600 }, /tax_total_amount \(600\).*\(650\)/],
    ['a wrong total_amount', { totalAmount: 5000 }, /total_amount \(5000\).*\(5650\)/],
    ['a wrong subtotal_amount', { subtotalAmount: 4999 }, /subtotal_amount \(4999\).*\(5000\)/],
    ['a non-integer total_amount', { totalAmount: 56.5 }, /total_amount must be an integer/],
  ])('client-supplied %s → 400, nothing written', (_label, override, message) => {
    it('is rejected before any write or attestation', async () => {
      queueRegistrations([REG_ON]);
      const result = await createPaymentRequest({ ...CHARGED_BASE, chargeTax: true, taxes: [ON_ROW], ...override });
      expect(isServiceError(result)).toBe(true);
      if (isServiceError(result)) {
        expect(result.status).toBe(400);
        expect(result.error).toMatch(message);
      }
      expect(state.insertCalls).toHaveLength(0);
      expect(state.issuedAttestationMock).not.toHaveBeenCalled();
    });
  });

  it('a client claiming tax on an untaxed request (no charge_tax) is also caught: tax_total_amount must be 0', async () => {
    const result = await createPaymentRequest({ ...CHARGED_BASE, taxTotalAmount: 650, totalAmount: 5650 });
    expect(isServiceError(result)).toBe(true);
    if (isServiceError(result)) expect(result.status).toBe(400);
    expect(state.insertCalls).toHaveLength(0);
  });

  it('#2439 item 2: 400s when the collector (issuer) is not a seller in the manifest chain — payee_account is someone else', async () => {
    queueRegistrations([REG_ON]);
    const result = await createPaymentRequest({
      ...CHARGED_BASE,
      payeeAccount: 'did:imajin:other-payee',
      chargeTax: true,
      taxes: [ON_ROW],
    });
    expect(isServiceError(result)).toBe(true);
    if (isServiceError(result)) {
      expect(result.status).toBe(400);
      expect(result.error).toMatch(/collectorDid \(did:imajin:issuer\) must be a seller in fair_manifest\.chain/);
    }
    expect(state.insertCalls).toHaveLength(0);
  });

  it('#2439 item 2: 400s for a custom manifest + charge_tax whose chain has no issuer seller', async () => {
    queueRegistrations([REG_ON]);
    const result = await createPaymentRequest({
      ...CHARGED_BASE,
      chargeTax: true,
      taxes: [ON_ROW],
      fairManifest: { chain: [{ did: 'did:imajin:someone-else', role: 'seller', share: 1 }], total: { amount: 5000, currency: 'CAD' } },
    });
    expect(isServiceError(result)).toBe(true);
    if (isServiceError(result)) expect(result.error).toMatch(/must be a seller/);
    expect(state.insertCalls).toHaveLength(0);
  });

  it('merges the rebuilt taxes[] into a valid custom manifest and stamps fair "1.2"', async () => {
    queueRegistrations([REG_ON]);
    const chain = [{ did: ISSUER_DID, role: 'seller', share: 1 }];
    const result = await createPaymentRequest({
      ...CHARGED_BASE,
      chargeTax: true,
      taxes: [ON_ROW],
      fairManifest: { chain, total: { amount: 5000, currency: 'CAD' } },
    });
    expect(isServiceError(result)).toBe(false);
    expect(state.insertCalls[0].fairManifest).toEqual({ chain, total: { amount: 5000, currency: 'CAD' }, taxes: [TAX_ROW_ON], fair: '1.2' });
  });

  it('400s when the issuer has no matching registration on their profile', async () => {
    queueRegistrations([REG_BC_PST]);
    const result = await createPaymentRequest({ ...CHARGED_BASE, chargeTax: true, taxes: [ON_ROW] });
    expect(isServiceError(result)).toBe(true);
    if (isServiceError(result)) {
      expect(result.status).toBe(400);
      expect(result.error).toMatch(/no GST\/HST tax registration for CA-ON/);
    }
    expect(state.insertCalls).toHaveLength(0);
  });

  it('400s when the issuer has no profile / no registrations at all', async () => {
    state.selectQueue.push([]);
    const result = await createPaymentRequest({ ...CHARGED_BASE, chargeTax: true, taxes: [ON_ROW] });
    expect(isServiceError(result)).toBe(true);
    if (isServiceError(result)) expect(result.status).toBe(400);
  });

  it.each([
    ['charge_tax is not a boolean', { chargeTax: 'yes', taxes: [ON_ROW] }, /charge_tax must be a boolean/],
    ['charge_tax is true but taxes is missing', { chargeTax: true }, /taxes must be a non-empty array/],
    ['charge_tax is true but taxes is empty', { chargeTax: true, taxes: [] }, /taxes must be a non-empty array/],
    ['taxes are sent without charge_tax', { taxes: [ON_ROW] }, /taxes requires charge_tax: true/],
    ['a row has a non-integer rate_bps (997.5 is never rounded)', { chargeTax: true, taxes: [{ ...ON_ROW, rate_bps: 997.5 }] }, /rate_bps must be an integer/],
    ['a row has a negative rate_bps', { chargeTax: true, taxes: [{ ...ON_ROW, rate_bps: -1 }] }, /rate_bps must be an integer/],
    ['a row repeats the same registration', { chargeTax: true, taxes: [ON_ROW, ON_ROW] }, /duplicates GST\/HST \(CA-ON\)/],
    ['a row is not an object', { chargeTax: true, taxes: ['13%'] }, /taxes\[0\] must be an object/],
    ['fair_manifest already carries taxes[]', { chargeTax: true, taxes: [ON_ROW], fairManifest: { taxes: [], total: { amount: 5000, currency: 'CAD' } } }, /cannot be combined with charge_tax/],
  ])('400s when %s', async (_label, override, message) => {
    const result = await createPaymentRequest({ ...CHARGED_BASE, ...override });
    expect(isServiceError(result)).toBe(true);
    if (isServiceError(result)) {
      expect(result.status).toBe(400);
      expect(result.error).toMatch(message);
    }
    expect(state.insertCalls).toHaveLength(0);
  });
});

describe('createPaymentRequest — custom manifest carrying taxes[] (#2419 path, #2421 totals)', () => {
  const CUSTOM = (taxes: unknown[], chainDid = ISSUER_DID) => ({
    fair: '1.2',
    chain: [{ did: chainDid, role: 'seller', share: 1 }],
    total: { amount: 5000, currency: 'CAD' },
    taxes,
  });

  it('#2439: rejects a custom manifest carrying taxes[] that is not stamped fair "1.2"', async () => {
    const result = await createPaymentRequest({ ...CHARGED_BASE, fairManifest: { ...CUSTOM([TAX_ROW_ON]), fair: undefined } });
    expect(isServiceError(result)).toBe(true);
    if (isServiceError(result)) {
      expect(result.status).toBe(400);
      expect(result.error).toMatch(/fair_manifest\.fair must be "1\.2"/);
    }
    expect(state.insertCalls).toHaveLength(0);
  });

  it('#2439 item 4: rejects a non-array taxes on a custom manifest at create time', async () => {
    const result = await createPaymentRequest({
      ...CHARGED_BASE,
      fairManifest: { chain: [{ did: ISSUER_DID, role: 'seller', share: 1 }], total: { amount: 5000, currency: 'CAD' }, taxes: 'GST' },
    });
    expect(isServiceError(result)).toBe(true);
    if (isServiceError(result)) expect(result.error).toMatch(/taxes must be an array/);
    expect(state.insertCalls).toHaveLength(0);
  });

  it('total = subtotal + Σ manifest tax amounts, so the row matches what checkout charges', async () => {
    const result = await createPaymentRequest({ ...CHARGED_BASE, fairManifest: CUSTOM([TAX_ROW_ON]) });
    expect(isServiceError(result)).toBe(false);
    expect(state.insertCalls[0]).toMatchObject({ subtotalAmount: 5000, taxTotalAmount: 650, totalAmount: 5650 });
  });

  it('rejects a taxes[] row whose collector is not the issuer', async () => {
    const foreign = { ...TAX_ROW_ON, collectorDid: 'did:imajin:other-seller' };
    const result = await createPaymentRequest({ ...CHARGED_BASE, fairManifest: CUSTOM([foreign], 'did:imajin:other-seller') });
    expect(isServiceError(result)).toBe(true);
    if (isServiceError(result)) expect(result.error).toMatch(/collectorDid.*must be the issuer/);
    expect(state.insertCalls).toHaveLength(0);
  });

  it('rejects (create-time, before any Stripe charge) a collector that is not a chain seller', async () => {
    const result = await createPaymentRequest({ ...CHARGED_BASE, fairManifest: CUSTOM([TAX_ROW_ON], 'did:imajin:not-the-issuer') });
    expect(isServiceError(result)).toBe(true);
    if (isServiceError(result)) expect(result.error).toMatch(/must be a seller in fair_manifest\.chain/);
    expect(state.insertCalls).toHaveLength(0);
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
    subtotalAmount: 5000,
    taxTotalAmount: 0,
    fairManifest: { chain: [], total: { amount: 5000, currency: 'CAD' } },
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
      subtotalAmount: 5000,
      taxTotalAmount: 0,
      taxes: [],
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

  it('#2421: exposes the tax breakdown (kind, jurisdiction, rate, amount, registration number) and never the collector/remit DIDs or manifest', async () => {
    const TAXED_ROW = {
      ...ROW,
      totalAmount: 5650,
      subtotalAmount: 5000,
      taxTotalAmount: 650,
      fairManifest: { chain: [], total: { amount: 5000, currency: 'CAD' }, taxes: [TAX_ROW_ON] },
    };
    state.selectQueue.push([TAXED_ROW]);
    state.selectQueue.push([{ displayName: 'Acme Co' }]);

    const result = await getPaymentRequestByHandle('ph_abc');

    expect(result).toMatchObject({ totalAmount: 5650, subtotalAmount: 5000, taxTotalAmount: 650 });
    expect(result?.taxes).toEqual([
      { jurisdiction: 'CA-ON', kind: 'GST/HST', rateBps: 1300, amount: 650, registrationNumber: '123456789RT0001' },
    ]);
    expect(JSON.stringify(result)).not.toContain('collectorDid');
    expect(JSON.stringify(result)).not.toContain('remitTo');
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

  it('#2421: the manual-settle receipt attestation carries the subtotal/tax/total breakdown when tax was charged, and none otherwise', async () => {
    state.selectQueue.push([issuedRow]);
    state.updateReturningQueue.push([{ ...issuedRow, status: 'settled_manual' }]);
    await settlePaymentRequestManual({ id: 'pr_1', callerDid: ISSUER_DID });
    expect(state.settledAttestationMock.mock.calls[0][0].tax).toBeNull();

    state.settledAttestationMock.mockClear();
    const taxedRow = {
      ...issuedRow,
      totalAmount: 5650,
      subtotalAmount: 5000,
      taxTotalAmount: 650,
      fairManifest: { taxes: [TAX_ROW_ON] },
    };
    state.selectQueue.push([taxedRow]);
    state.updateReturningQueue.push([{ ...taxedRow, status: 'settled_manual' }]);
    await settlePaymentRequestManual({ id: 'pr_1', callerDid: ISSUER_DID });

    const args = state.settledAttestationMock.mock.calls[0][0];
    expect(args.totalAmount).toBe(5650);
    expect(args.tax).toEqual({
      subtotalAmount: 5000,
      taxTotalAmount: 650,
      taxes: [{ jurisdiction: 'CA-ON', kind: 'GST/HST', rateBps: 1300, amount: 650, registrationNumber: '123456789RT0001' }],
    });
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
