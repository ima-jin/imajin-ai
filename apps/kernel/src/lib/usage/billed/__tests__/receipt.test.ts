import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resetInsertTransactionDouble } from './receipt-write-mocks';

const mocks = vi.hoisted(() => ({
  insertValues: vi.fn().mockResolvedValue(undefined),
  insert: vi.fn(),
  transaction: vi.fn(),
  getActiveAsset: vi.fn(),
  emitMechanicalAttestation: vi.fn(),
  getNodeSigningIdentity: vi.fn(),
  getRate: vi.fn(),
  convert: vi.fn(),
  signFxSnapshot: vi.fn(),
  toDecimalString: vi.fn(),
}));

vi.mock('@/src/db', () => ({
  db: { insert: mocks.insert, transaction: mocks.transaction },
  usageBilled: {},
}));

let idCounter = 0;
vi.mock('@/src/lib/kernel/id', () => ({
  generateId: (prefix: string) => `${prefix}_test${++idCounter}`,
}));

vi.mock('@/src/lib/media/queries', () => ({
  getActiveAsset: mocks.getActiveAsset,
}));

vi.mock('@/src/lib/auth/emit-mechanical-attestation', () => ({
  emitMechanicalAttestation: mocks.emitMechanicalAttestation,
}));

vi.mock('@/src/lib/vault/sealing', () => ({
  getNodeSigningIdentity: mocks.getNodeSigningIdentity,
}));

vi.mock('@imajin/money', () => ({
  getRate: mocks.getRate,
  convert: mocks.convert,
  signFxSnapshot: mocks.signFxSnapshot,
  toDecimalString: mocks.toDecimalString,
}));

import { confirmReceiptLines, type ConfirmReceiptInput } from '../receipt';

const PRINCIPAL_DID = 'did:imajin:owner';
const ASSET = { id: 'asset_1', ownerDid: PRINCIPAL_DID, hash: 'sha256:receipt-bytes' };

function baseInput(overrides: Partial<ConfirmReceiptInput> = {}): ConfirmReceiptInput {
  return {
    principalDid: PRINCIPAL_DID,
    assetId: 'asset_1',
    currency: 'USD',
    receiptTotalMinor: 3000,
    lines: [
      { description: 'Laptop stand', category: 'hardware', amountMinor: 2000, date: new Date('2026-06-01T00:00:00.000Z'), vendor: 'Acme' },
      { description: 'USB hub', category: 'hardware', amountMinor: 1000, date: new Date('2026-06-01T00:00:00.000Z'), vendor: 'Acme' },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  idCounter = 0;
  vi.clearAllMocks();
  resetInsertTransactionDouble(mocks);
  mocks.getActiveAsset.mockResolvedValue(ASSET);
  mocks.emitMechanicalAttestation.mockResolvedValue('att_receipt');
  mocks.toDecimalString.mockImplementation((money: { amount: number }) => (money.amount / 100).toFixed(2));
});

describe('confirmReceiptLines — evidence asset resolution', () => {
  it('returns a typed error and never writes when the asset does not exist', async () => {
    mocks.getActiveAsset.mockResolvedValue(undefined);

    const result = await confirmReceiptLines(baseInput());

    expect(result).toEqual({ error: 'evidence_asset_not_found' });
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.emitMechanicalAttestation).not.toHaveBeenCalled();
  });

  it('returns a typed error and never writes when the asset is owned by someone else', async () => {
    mocks.getActiveAsset.mockResolvedValue({ ...ASSET, ownerDid: 'did:imajin:someone-else' });

    const result = await confirmReceiptLines(baseInput());

    expect(result).toEqual({ error: 'evidence_asset_not_owned' });
    expect(mocks.insert).not.toHaveBeenCalled();
  });
});

describe('confirmReceiptLines — D3 sum invariant', () => {
  it('rejects when lines do not sum to the declared receipt total, without writing anything', async () => {
    const result = await confirmReceiptLines(baseInput({ receiptTotalMinor: 9999 }));

    expect(result).toEqual({ error: 'sum_mismatch', expectedMinor: 9999, actualMinor: 3000 });
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.emitMechanicalAttestation).not.toHaveBeenCalled();
  });

  it('rejects an empty lines array before touching the DB', async () => {
    const result = await confirmReceiptLines(baseInput({ lines: [] }));

    expect(result).toEqual({ error: 'empty_lines' });
    expect(mocks.getActiveAsset).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('accepts an exact sum match', async () => {
    const result = await confirmReceiptLines(baseInput());
    expect('error' in result).toBe(false);
  });
});

describe('confirmReceiptLines — hash binding', () => {
  it('binds every line to the asset content hash via evidenceAssetId/evidenceContentHash', async () => {
    await confirmReceiptLines(baseInput());

    const rows = mocks.insertValues.mock.calls[0][0] as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.evidenceAssetId).toBe('asset_1');
      expect(row.evidenceContentHash).toBe('sha256:receipt-bytes');
    }
  });

  it('assigns a shared receiptId and 1-based sequential lineNo across all rows', async () => {
    await confirmReceiptLines(baseInput());

    const rows = mocks.insertValues.mock.calls[0][0] as Record<string, unknown>[];
    expect(rows[0].receiptId).toBe(rows[1].receiptId);
    expect(rows[0].lineNo).toBe(1);
    expect(rows[1].lineNo).toBe(2);
  });

  it('writes source=receipt:manual and granularity=manual on every row (never usage.incurred)', async () => {
    await confirmReceiptLines(baseInput());

    const rows = mocks.insertValues.mock.calls[0][0] as Record<string, unknown>[];
    for (const row of rows) {
      expect(row.source).toBe('receipt:manual');
      expect(row.granularity).toBe('manual');
    }
  });

  it('writes all rows in a single transaction (atomic all-or-nothing)', async () => {
    await confirmReceiptLines(baseInput());
    expect(mocks.transaction).toHaveBeenCalledOnce();
  });
});

describe('confirmReceiptLines — USD identity path (no FX)', () => {
  it('never calls getRate/convert/signFxSnapshot for a USD receipt', async () => {
    await confirmReceiptLines(baseInput());

    expect(mocks.getRate).not.toHaveBeenCalled();
    expect(mocks.convert).not.toHaveBeenCalled();
    expect(mocks.signFxSnapshot).not.toHaveBeenCalled();
  });

  it('leaves fx_* columns null for USD rows', async () => {
    await confirmReceiptLines(baseInput());

    const rows = mocks.insertValues.mock.calls[0][0] as Record<string, unknown>[];
    for (const row of rows) {
      expect(row.fxRate).toBeNull();
      expect(row.fxSource).toBeNull();
      expect(row.fxAsOf).toBeNull();
      expect(row.fxSignature).toBeNull();
    }
  });
});

describe('confirmReceiptLines — non-USD FX conversion', () => {
  const CAD_SNAPSHOT = { base: 'CAD', quote: 'USD', rate: '0.73', source: 'ecb:triangulated', asOf: '2026-06-01' };
  const SIGNED_SNAPSHOT = { ...CAD_SNAPSHOT, signature: 'deadbeef' };

  beforeEach(() => {
    mocks.getRate.mockResolvedValue(CAD_SNAPSHOT);
    mocks.convert.mockImplementation((money: { amount: number }, snapshot: { rate: string }) => ({
      amount: Math.round(money.amount * Number(snapshot.rate)),
      currency: 'USD',
    }));
    mocks.signFxSnapshot.mockResolvedValue(SIGNED_SNAPSHOT);
    mocks.getNodeSigningIdentity.mockReturnValue({ privateKeyHex: 'nodekey', senderPubkey: 'pub', senderDid: 'did:imajin:node' });
  });

  it('resolves a signed FxSnapshot per line and persists it alongside the row', async () => {
    const result = await confirmReceiptLines(
      baseInput({
        currency: 'CAD',
        lines: [{ description: 'Server rack', category: 'infra', amountMinor: 3000, date: new Date('2026-06-01T00:00:00.000Z'), vendor: 'Acme' }],
        receiptTotalMinor: 3000,
      }),
    );

    expect('error' in result).toBe(false);
    expect(mocks.getRate).toHaveBeenCalledWith('CAD', 'USD', '2026-06-01', expect.anything());
    expect(mocks.signFxSnapshot).toHaveBeenCalledWith(CAD_SNAPSHOT, 'nodekey');

    const rows = mocks.insertValues.mock.calls[0][0] as Record<string, unknown>[];
    expect(rows[0]).toMatchObject({
      currency: 'CAD',
      fxRate: '0.73',
      fxSource: 'ecb:triangulated',
      fxAsOf: '2026-06-01',
      fxSignature: 'deadbeef',
    });
  });

  it('returns a typed fx_unavailable error and writes nothing when rate resolution throws', async () => {
    mocks.getRate.mockRejectedValueOnce(new Error('ECB unreachable'));

    const result = await confirmReceiptLines(
      baseInput({
        currency: 'CAD',
        lines: [{ description: 'Server rack', category: 'infra', amountMinor: 3000, date: new Date('2026-06-01T00:00:00.000Z'), vendor: 'Acme' }],
        receiptTotalMinor: 3000,
      }),
    );

    expect(result).toMatchObject({ error: 'fx_unavailable' });
    expect(mocks.insert).not.toHaveBeenCalled();
  });
});

describe('confirmReceiptLines — attestation privacy (D3)', () => {
  it('mints ONE attestation over the whole receipt, never the asset bytes', async () => {
    await confirmReceiptLines(baseInput());

    expect(mocks.emitMechanicalAttestation).toHaveBeenCalledOnce();
    const call = mocks.emitMechanicalAttestation.mock.calls[0][0];
    expect(call).toMatchObject({
      subjectDid: PRINCIPAL_DID,
      type: 'usage.billed',
      contextType: 'usage.receipt',
    });
    const payloadStr = JSON.stringify(call.payload);
    // Only the content hash reference travels, never raw bytes/base64 of the receipt.
    expect(call.payload.evidenceContentHash).toBe('sha256:receipt-bytes');
    expect(payloadStr).not.toMatch(/base64|data:image/i);
  });

  it('returns the attestation id from emitMechanicalAttestation', async () => {
    mocks.emitMechanicalAttestation.mockResolvedValueOnce('att_specific');

    const result = await confirmReceiptLines(baseInput());

    expect(result).toMatchObject({ attestationId: 'att_specific' });
  });
});
