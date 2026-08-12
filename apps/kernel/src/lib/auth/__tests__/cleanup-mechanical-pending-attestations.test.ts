/**
 * Tests for the #1825 bulk-cleanup logic that resolves stale pending
 * `session.created` (and any other mechanical-type) attestations left over
 * from before #1822 shipped the source fix.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
  const selectWhereMock = vi.fn();
  const selectFromMock = vi.fn(() => ({ where: selectWhereMock }));
  const selectMock = vi.fn(() => ({ from: selectFromMock }));

  const updateReturningMock = vi.fn();
  const updateWhereMock = vi.fn(() => ({ returning: updateReturningMock }));
  const updateSetMock = vi.fn(() => ({ where: updateWhereMock }));
  const updateMock = vi.fn(() => ({ set: updateSetMock }));

  return {
    selectWhereMock,
    selectFromMock,
    selectMock,
    updateReturningMock,
    updateWhereMock,
    updateSetMock,
    updateMock,
  };
});

vi.mock('@/src/db', () => ({
  db: { select: mocks.selectMock, update: mocks.updateMock },
  attestations: {
    id: 'attestations.id',
    type: 'attestations.type',
    attestationStatus: 'attestations.attestationStatus',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: (...args: unknown[]) => ({ op: 'eq', args }),
  and: (...args: unknown[]) => ({ op: 'and', args }),
}));

vi.mock('@imajin/auth', () => ({
  MECHANICAL_ATTESTATION_TYPES: ['session.created'],
}));

import {
  countMechanicalPendingAttestations,
  cleanupMechanicalPendingAttestations,
} from '../cleanup-mechanical-pending-attestations';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('countMechanicalPendingAttestations (#1825)', () => {
  it('counts pending rows per mechanical type without writing anything', async () => {
    mocks.selectWhereMock.mockResolvedValueOnce([{ id: 'att_1' }, { id: 'att_2' }]);

    const result = await countMechanicalPendingAttestations();

    expect(result).toEqual([{ type: 'session.created', matched: 2 }]);
    expect(mocks.updateMock).not.toHaveBeenCalled();
  });

  it('reports zero when nothing is pending', async () => {
    mocks.selectWhereMock.mockResolvedValueOnce([]);

    const result = await countMechanicalPendingAttestations();

    expect(result).toEqual([{ type: 'session.created', matched: 0 }]);
  });
});

describe('cleanupMechanicalPendingAttestations (#1825)', () => {
  it('clears attestationStatus to null for pending mechanical rows', async () => {
    mocks.updateReturningMock.mockResolvedValueOnce([{ id: 'att_1' }, { id: 'att_2' }, { id: 'att_3' }]);

    const result = await cleanupMechanicalPendingAttestations();

    expect(result).toEqual([{ type: 'session.created', matched: 3 }]);
    expect(mocks.updateSetMock).toHaveBeenCalledWith({ attestationStatus: null });
  });

  it('is a no-op when nothing is pending (idempotent re-run)', async () => {
    mocks.updateReturningMock.mockResolvedValueOnce([]);

    const result = await cleanupMechanicalPendingAttestations();

    expect(result).toEqual([{ type: 'session.created', matched: 0 }]);
    expect(mocks.updateMock).toHaveBeenCalledOnce();
  });

  it('only targets rows currently at attestation_status = pending', async () => {
    mocks.updateReturningMock.mockResolvedValueOnce([]);

    await cleanupMechanicalPendingAttestations();

    const whereArg = mocks.updateWhereMock.mock.calls[0][0] as { op: string; args: unknown[] };
    expect(whereArg.op).toBe('and');
    const eqArgs = whereArg.args as Array<{ op: string; args: unknown[] }>;
    expect(eqArgs.some((c) => c.op === 'eq' && c.args[1] === 'session.created')).toBe(true);
    expect(eqArgs.some((c) => c.op === 'eq' && c.args[1] === 'pending')).toBe(true);
  });
});
