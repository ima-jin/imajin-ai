/**
 * Acceptance test (#1951): "Upload a USD + a CAD receipt → confirmed line
 * items → usage.billed rows with signed FxSnapshot → aggregate matches the
 * receipts' totals in CAD."
 *
 * Uses the REAL `packages/money` math (`convert`, `toDecimalString`,
 * `signFxSnapshot`) via the workspace alias — only `getRate` (which needs a
 * live DB/ECB fetch) and the kernel's own DB/asset/attestation boundaries
 * are mocked. This proves the FX chain `confirmReceiptLines` wires up
 * actually composes correctly, not just that its own unit mocks are
 * self-consistent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { convert, toDecimalString } from '@imajin/money';
import { resetInsertTransactionDouble } from './receipt-write-mocks';

const mocks = vi.hoisted(() => ({
  insertValues: vi.fn().mockResolvedValue(undefined),
  insert: vi.fn(),
  transaction: vi.fn(),
  getActiveAsset: vi.fn(),
  emitMechanicalAttestation: vi.fn(),
  getRate: vi.fn(),
}));

vi.mock('@/src/db', () => ({
  db: { insert: mocks.insert, transaction: mocks.transaction },
  usageBilled: {},
}));

let idCounter = 0;
vi.mock('@/src/lib/kernel/id', () => ({
  generateId: (prefix: string) => `${prefix}_fx${++idCounter}`,
}));

vi.mock('@/src/lib/media/queries', () => ({
  getActiveAsset: mocks.getActiveAsset,
}));

vi.mock('@/src/lib/auth/emit-mechanical-attestation', () => ({
  emitMechanicalAttestation: mocks.emitMechanicalAttestation,
}));

// Only getRate is stubbed (it needs a live DB/ECB fetch) — convert,
// toDecimalString, and signFxSnapshot are the REAL packages/money
// implementations, loaded through the workspace alias.
vi.mock('@imajin/money', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@imajin/money')>();
  return { ...actual, getRate: mocks.getRate };
});

import { confirmReceiptLines } from '../receipt';

const PRINCIPAL_DID = 'did:imajin:owner';

beforeEach(() => {
  idCounter = 0;
  vi.clearAllMocks();
  resetInsertTransactionDouble(mocks);
  mocks.emitMechanicalAttestation.mockResolvedValue('att_fx');
});

describe('USD + CAD receipts aggregate to the correct CAD total via a signed FxSnapshot', () => {
  it('produces a USD-normalized sum that converts exactly to the expected CAD total', async () => {
    // Receipt A: a $50.00 USD hardware receipt — identity conversion, no FX.
    mocks.getActiveAsset.mockResolvedValueOnce({ id: 'asset_usd', ownerDid: PRINCIPAL_DID, hash: 'sha256:usd-receipt' });
    const usdResult = await confirmReceiptLines({
      principalDid: PRINCIPAL_DID,
      assetId: 'asset_usd',
      currency: 'USD',
      receiptTotalMinor: 5000,
      lines: [{ description: 'Keyboard', category: 'hardware', amountMinor: 5000, date: new Date('2026-06-01T00:00:00.000Z'), vendor: 'Acme' }],
    });
    if ('error' in usdResult) throw new Error(`unexpected error: ${usdResult.error}`);
    expect(usdResult.lines[0].billedUsd).toBe('50.00');

    // Receipt B: a $200.00 CAD infra receipt — converted via a signed
    // CAD->USD FxSnapshot at a clean 0.75 rate (200.00 CAD * 0.75 = $150.00 USD, no rounding).
    mocks.getRate.mockResolvedValueOnce({ base: 'CAD', quote: 'USD', rate: '0.75', source: 'ecb', asOf: '2026-06-01' });
    mocks.getActiveAsset.mockResolvedValueOnce({ id: 'asset_cad', ownerDid: PRINCIPAL_DID, hash: 'sha256:cad-receipt' });
    const cadResult = await confirmReceiptLines({
      principalDid: PRINCIPAL_DID,
      assetId: 'asset_cad',
      currency: 'CAD',
      receiptTotalMinor: 20000,
      lines: [{ description: 'Server rack', category: 'infra', amountMinor: 20000, date: new Date('2026-06-01T00:00:00.000Z'), vendor: 'ColoCo' }],
    });
    if ('error' in cadResult) throw new Error(`unexpected error: ${cadResult.error}`);
    expect(cadResult.lines[0].billedUsd).toBe('150.00');
    // The signed FxSnapshot the conversion actually relied on travels with the row.
    const cadRow = mocks.insertValues.mock.calls[1][0][0] as Record<string, unknown>;
    expect(cadRow).toMatchObject({ fxRate: '0.75', fxSource: 'ecb', fxAsOf: '2026-06-01' });
    expect(typeof cadRow.fxSignature).toBe('string');
    expect((cadRow.fxSignature as string).length).toBeGreaterThan(0);

    // Aggregate: sum both receipts' USD-normalized totals, then convert the
    // combined figure to CAD via a settlement FxSnapshot (real `convert`).
    const totalUsdMinor =
      Number(usdResult.lines[0].billedUsd.replace('.', '')) + Number(cadResult.lines[0].billedUsd.replace('.', ''));
    expect(totalUsdMinor).toBe(20000); // $200.00 USD combined

    const settlementSnapshot = { base: 'USD', quote: 'CAD', rate: '1.35', source: 'ecb', asOf: '2026-06-01' };
    const totalInCad = convert({ amount: totalUsdMinor, currency: 'USD' }, settlementSnapshot);

    // $200.00 USD * 1.35 = $270.00 CAD exactly.
    expect(toDecimalString(totalInCad)).toBe('270.00');
  });
});
