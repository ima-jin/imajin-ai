/**
 * Tests for emitRecoveryCodesGeneratedAttestation / emitRecoveryRedeemedAttestation
 * (#1250 Phase 1). Both are mechanical audit records minted by the kernel
 * node identity, mirroring `emitSessionAttestation` (#1822) — never an
 * `author_jws`, never awaiting a countersignature.
 *
 * Uses an in-memory row store for the `attestations` insert (same style as
 * `recovery-codes.test.ts`) rather than a call-tracking mock object, so
 * assertions read the actually-persisted row shape.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  attestationRows: [] as Row[],
  getNodeDidMock: vi.fn(),
  computeCidMock: vi.fn(),
  insertShouldThrow: false,
}));

vi.mock('@/src/db', () => ({
  db: {
    insert: () => ({
      values: (row: Row) => {
        if (state.insertShouldThrow) return Promise.reject(new Error('db down'));
        state.attestationRows.push(row);
        return Promise.resolve([]);
      },
    }),
  },
  attestations: { __table: 'attestations' },
}));

vi.mock('@imajin/auth', () => ({
  canonicalize: (value: unknown) => JSON.stringify(value),
  crypto: { signSync: () => 'deterministic-signature' },
}));

vi.mock('@imajin/cid', () => ({
  computeCid: state.computeCidMock,
}));

vi.mock('@/src/lib/kernel/node-identity', () => ({
  getNodeDid: state.getNodeDidMock,
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { emitRecoveryCodesGeneratedAttestation, emitRecoveryRedeemedAttestation } from '../emit-recovery-attestation';

const NODE_DID = 'did:imajin:platformnode';
const SUBJECT_DID = 'did:imajin:recoverable';

function lastRow(): Row {
  return state.attestationRows.at(-1) as Row;
}

beforeEach(() => {
  state.attestationRows.length = 0;
  state.insertShouldThrow = false;
  state.getNodeDidMock.mockReset().mockResolvedValue(NODE_DID);
  state.computeCidMock.mockReset().mockResolvedValue('bafy-recovery');
  process.env.AUTH_PRIVATE_KEY = 'test-private-key';
});

describe('emitRecoveryCodesGeneratedAttestation', () => {
  it('persists a recovery.codes.generated row carrying only the count', async () => {
    await emitRecoveryCodesGeneratedAttestation({ did: SUBJECT_DID, count: 10 });

    expect(state.attestationRows).toHaveLength(1);
    const row = lastRow();
    expect(row.type).toBe('recovery.codes.generated');
    expect(row.subjectDid).toBe(SUBJECT_DID);
    expect(row.issuerDid).toBe(NODE_DID);
    expect(row.payload).toEqual({ count: 10 });
    expect(row.attestationStatus).toBeNull();
    expect(JSON.stringify(row)).not.toMatch(/[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}/);
  });

  for (const missing of ['AUTH_PRIVATE_KEY', 'nodeDid'] as const) {
    it(`writes nothing when ${missing} is unavailable`, async () => {
      if (missing === 'AUTH_PRIVATE_KEY') delete process.env.AUTH_PRIVATE_KEY;
      else state.getNodeDidMock.mockResolvedValue('');

      await emitRecoveryCodesGeneratedAttestation({ did: SUBJECT_DID, count: 10 });

      expect(state.attestationRows).toHaveLength(0);
    });
  }

  it('swallows a persistence failure rather than throwing', async () => {
    state.insertShouldThrow = true;

    await expect(emitRecoveryCodesGeneratedAttestation({ did: SUBJECT_DID, count: 10 })).resolves.toBeUndefined();
  });
});

describe('emitRecoveryRedeemedAttestation', () => {
  it('persists a recovery.redeemed row with an empty payload', async () => {
    await emitRecoveryRedeemedAttestation({ did: SUBJECT_DID });

    const row = lastRow();
    expect(row.type).toBe('recovery.redeemed');
    expect(row.subjectDid).toBe(SUBJECT_DID);
    expect(row.payload).toEqual({});
    expect(row.attestationStatus).toBeNull();
  });

  it('still persists the row when CID computation fails, with a null cid', async () => {
    state.computeCidMock.mockRejectedValueOnce(new Error('cid service unavailable'));

    await emitRecoveryRedeemedAttestation({ did: SUBJECT_DID });

    expect(lastRow().cid).toBeNull();
  });

  it('writes nothing without a node DID', async () => {
    state.getNodeDidMock.mockResolvedValue('');

    await emitRecoveryRedeemedAttestation({ did: SUBJECT_DID });

    expect(state.attestationRows).toHaveLength(0);
  });
});
