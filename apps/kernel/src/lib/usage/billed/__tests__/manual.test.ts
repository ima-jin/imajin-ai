import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  insertValues: vi.fn().mockResolvedValue(undefined),
  insert: vi.fn(),
  getActiveAsset: vi.fn(),
  emitMechanicalAttestation: vi.fn(),
}));

mocks.insert.mockImplementation(() => ({ values: mocks.insertValues }));

vi.mock('@/src/db', () => ({
  db: { insert: mocks.insert },
  usageBilled: {},
}));

vi.mock('@/src/lib/kernel/id', () => ({
  generateId: (prefix: string) => `${prefix}_test123`,
}));

vi.mock('@/src/lib/media/queries', () => ({
  getActiveAsset: mocks.getActiveAsset,
}));

vi.mock('@/src/lib/auth/emit-mechanical-attestation', () => ({
  emitMechanicalAttestation: mocks.emitMechanicalAttestation,
}));

import { insertManualBilledLine } from '../manual';

const PRINCIPAL_DID = 'did:imajin:owner';

function baseInput(overrides: Partial<Parameters<typeof insertManualBilledLine>[0]> = {}) {
  return {
    principalDid: PRINCIPAL_DID,
    vendor: 'Warp',
    periodStart: new Date('2026-06-01T00:00:00.000Z'),
    periodEnd: new Date('2026-06-30T23:59:59.000Z'),
    amountMinor: 12345,
    currency: 'USD',
    category: null,
    description: null,
    source: 'manual' as const,
    evidenceAssetId: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.insert.mockImplementation(() => ({ values: mocks.insertValues }));
  mocks.insertValues.mockResolvedValue(undefined);
  mocks.emitMechanicalAttestation.mockResolvedValue('att_generated');
});

describe('insertManualBilledLine', () => {
  it('inserts a usage.billed row with granularity "manual" and a USD-cents billedUsd projection', async () => {
    await insertManualBilledLine(baseInput());

    const inserted = mocks.insertValues.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted).toMatchObject({
      id: 'billed_test123',
      principalDid: PRINCIPAL_DID,
      provider: 'Warp',
      granularity: 'manual',
      model: null,
      billedUsd: '123.45000000',
      source: 'manual',
      currency: 'USD',
      amountMinor: 12345,
      evidenceAssetId: null,
      evidenceContentHash: null,
    });
  });

  it('mints a usage.billed attestation on the principal DID binding the line item', async () => {
    await insertManualBilledLine(baseInput({ category: 'infra', description: 'June Warp usage' }));

    expect(mocks.emitMechanicalAttestation).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectDid: PRINCIPAL_DID,
        type: 'usage.billed',
        contextId: 'billed_test123',
        contextType: 'usage.billed',
        payload: expect.objectContaining({
          billedId: 'billed_test123',
          vendor: 'Warp',
          amountMinor: 12345,
          currency: 'USD',
          category: 'infra',
          description: 'June Warp usage',
          source: 'manual',
        }),
      }),
    );
  });

  it('returns the attestation id from emitMechanicalAttestation on success', async () => {
    mocks.emitMechanicalAttestation.mockResolvedValueOnce('att_abc');

    const result = await insertManualBilledLine(baseInput());

    expect(result).toMatchObject({ attestationId: 'att_abc' });
  });

  it('resolves and binds the evidence asset content hash when evidenceAssetId is owned by the principal', async () => {
    mocks.getActiveAsset.mockResolvedValue({ id: 'asset_1', ownerDid: PRINCIPAL_DID, hash: 'sha256:abc' });

    const result = await insertManualBilledLine(baseInput({ source: 'document', evidenceAssetId: 'asset_1' }));

    expect(mocks.getActiveAsset).toHaveBeenCalledWith('asset_1');
    const inserted = mocks.insertValues.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted.evidenceAssetId).toBe('asset_1');
    expect(inserted.evidenceContentHash).toBe('sha256:abc');
    expect(result).toMatchObject({ evidenceAssetId: 'asset_1', evidenceContentHash: 'sha256:abc' });
  });

  it('returns a typed error and never writes when the evidence asset does not exist', async () => {
    mocks.getActiveAsset.mockResolvedValue(undefined);

    const result = await insertManualBilledLine(baseInput({ source: 'document', evidenceAssetId: 'asset_missing' }));

    expect(result).toEqual({ error: 'evidence_asset_not_found' });
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.emitMechanicalAttestation).not.toHaveBeenCalled();
  });

  it('returns a typed error and never writes when the evidence asset is owned by someone else', async () => {
    mocks.getActiveAsset.mockResolvedValue({ id: 'asset_1', ownerDid: 'did:imajin:someone-else', hash: 'sha256:abc' });

    const result = await insertManualBilledLine(baseInput({ source: 'document', evidenceAssetId: 'asset_1' }));

    expect(result).toEqual({ error: 'evidence_asset_not_owned' });
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('never resolves evidence when evidenceAssetId is absent', async () => {
    await insertManualBilledLine(baseInput());

    expect(mocks.getActiveAsset).not.toHaveBeenCalled();
  });
});
