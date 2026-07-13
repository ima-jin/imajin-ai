import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const {
  mockUpdateSetWhere, mockUpdateSet, mockSelectWhereLimit,
  mockSelectWhere, mockSelectFrom, mockDbUpdate, mockDbSelect,
} = vi.hoisted(() => {
  const mockUpdateSetWhere = vi.fn().mockResolvedValue(undefined);
  const mockUpdateSet = vi.fn(() => ({ where: mockUpdateSetWhere }));
  const mockSelectWhereLimit = vi.fn();
  const mockSelectWhere = vi.fn(() => ({ limit: mockSelectWhereLimit }));
  const mockSelectFrom = vi.fn(() => ({ where: mockSelectWhere }));
  const mockDbUpdate = vi.fn(() => ({ set: mockUpdateSet }));
  const mockDbSelect = vi.fn(() => ({ from: mockSelectFrom }));
  return { mockUpdateSetWhere, mockUpdateSet, mockSelectWhereLimit, mockSelectWhere, mockSelectFrom, mockDbUpdate, mockDbSelect };
});

vi.mock('@/src/db', () => ({
  db: {
    update: mockDbUpdate,
    select: mockDbSelect,
  },
  inferenceSessions: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({ type: 'eq' })),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() })),
}));

// ─── Subject ────────────────────────────────────────────────────────────────

import { resolveConsentGate, confirmIntent } from '../consent';
import type { CandidateIntent } from '../types';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeIntent(consentTier: CandidateIntent['consentTier']): CandidateIntent {
  return {
    intentType: 'supply.received',
    confidence: 0.9,
    metadata: {},
    consentTier,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdateSet.mockImplementation(() => ({ where: mockUpdateSetWhere }));
  mockUpdateSetWhere.mockResolvedValue(undefined);
  mockSelectFrom.mockImplementation(() => ({ where: mockSelectWhere }));
  mockSelectWhere.mockImplementation(() => ({ limit: mockSelectWhereLimit }));
  mockDbUpdate.mockImplementation(() => ({ set: mockUpdateSet }));
  mockDbSelect.mockImplementation(() => ({ from: mockSelectFrom }));
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('resolveConsentGate', () => {
  it('returns proceed and sets status=resolving for a silent intent', async () => {
    const outcome = await resolveConsentGate('session_1', makeIntent('silent'));

    expect(outcome).toBe('proceed');
    expect(mockUpdateSet).toHaveBeenCalledOnce();
    const setArg = mockUpdateSet.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg['status']).toBe('resolving');
    expect(setArg['chosenIntentType']).toBe('supply.received');
    expect(setArg['consentTier']).toBe('silent');
  });

  it('returns pending_confirm and sets status=pending_confirm for a deliberate intent', async () => {
    const outcome = await resolveConsentGate('session_2', makeIntent('deliberate'));

    expect(outcome).toBe('pending_confirm');
    expect(mockUpdateSet).toHaveBeenCalledOnce();
    const setArg = mockUpdateSet.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg['status']).toBe('pending_confirm');
    expect(setArg['chosenIntentType']).toBe('supply.received');
    expect(setArg['consentTier']).toBe('deliberate');
  });

  it('treats itemized as deliberate (v1 policy: no silent disclosure)', async () => {
    const outcome = await resolveConsentGate('session_3', makeIntent('itemized'));

    expect(outcome).toBe('pending_confirm');
    const setArg = mockUpdateSet.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg['status']).toBe('pending_confirm');
  });
});

describe('confirmIntent', () => {
  it('throws if the session is not found', async () => {
    mockSelectWhereLimit.mockResolvedValueOnce([]);

    await expect(confirmIntent('session_x', 'did:imajin:owner')).rejects.toThrow('not found');
  });

  it('throws if the session belongs to a different owner', async () => {
    mockSelectWhereLimit.mockResolvedValueOnce([{
      id: 'session_x',
      ownerDid: 'did:imajin:other',
      status: 'pending_confirm',
    }]);

    await expect(confirmIntent('session_x', 'did:imajin:owner')).rejects.toThrow('owner mismatch');
  });

  it('throws if the session is not in pending_confirm state', async () => {
    mockSelectWhereLimit.mockResolvedValueOnce([{
      id: 'session_x',
      ownerDid: 'did:imajin:owner',
      status: 'resolved',
    }]);

    await expect(confirmIntent('session_x', 'did:imajin:owner')).rejects.toThrow('awaiting confirmation');
  });

  it('advances session to resolving when ownership and status are valid', async () => {
    mockSelectWhereLimit.mockResolvedValueOnce([{
      id: 'session_x',
      ownerDid: 'did:imajin:owner',
      status: 'pending_confirm',
    }]);

    await confirmIntent('session_x', 'did:imajin:owner');

    expect(mockUpdateSet).toHaveBeenCalledOnce();
    const setArg = mockUpdateSet.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg['status']).toBe('resolving');
  });
});
