import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
  const state: { selectRows: unknown[]; returningRow: unknown } = { selectRows: [], returningRow: undefined };
  const insertValues: Record<string, unknown>[] = [];
  const conflictSets: Record<string, unknown>[] = [];

  function mockWhere() {
    return {
      limit: async () => state.selectRows,
      orderBy: async () => state.selectRows,
    };
  }

  function mockFrom() {
    return { where: mockWhere };
  }

  const selectMock = vi.fn(() => ({ from: mockFrom }));

  async function mockReturning() {
    return [state.returningRow];
  }

  function mockOnConflictDoUpdate({ set }: { set: Record<string, unknown> }) {
    conflictSets.push(set);
    return { returning: mockReturning };
  }

  function mockValues(v: Record<string, unknown>) {
    insertValues.push(v);
    return { onConflictDoUpdate: mockOnConflictDoUpdate };
  }

  const insertMock = vi.fn(() => ({ values: mockValues }));

  return { state, insertValues, conflictSets, selectMock, insertMock };
});

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ col, val }),
}));

vi.mock('@/src/db', () => ({
  db: { select: mocks.selectMock, insert: mocks.insertMock },
  usageEmitters: {
    source: 'source',
    issuerDid: 'issuer_did',
    status: 'status',
    createdAt: 'created_at',
  },
}));

import { getEmitter, listEmittersForIssuer, upsertEmitter, callerMatchesEmitter, isActiveEmitter } from '../emitters-store';

const ISSUER = 'did:imajin:jin';

beforeEach(() => {
  mocks.state.selectRows = [];
  mocks.state.returningRow = undefined;
  mocks.insertValues.length = 0;
  mocks.conflictSets.length = 0;
  mocks.selectMock.mockClear();
  mocks.insertMock.mockClear();
});

describe('getEmitter', () => {
  it('returns the first matching row', async () => {
    const emitterRow = { source: 'adapter:claude-code', issuerDid: ISSUER, actingFor: null, status: 'active' };
    mocks.state.selectRows = [emitterRow];

    await expect(getEmitter('adapter:claude-code')).resolves.toEqual(emitterRow);
  });

  it('returns undefined when no row matches', async () => {
    await expect(getEmitter('adapter:unknown')).resolves.toBeUndefined();
  });
});

describe('listEmittersForIssuer', () => {
  it('returns every row selected for the issuer', async () => {
    const rows = [{ source: 'adapter:claude-code' }, { source: 'adapter:warp' }];
    mocks.state.selectRows = rows;

    await expect(listEmittersForIssuer(ISSUER)).resolves.toEqual(rows);
  });
});

describe('upsertEmitter', () => {
  it('inserts with defaults for optional fields', async () => {
    mocks.state.returningRow = { source: 'adapter:claude-code', issuerDid: ISSUER, status: 'active' };

    await upsertEmitter({ source: 'adapter:claude-code', reader: 'tail-jsonl', issuerDid: ISSUER });

    expect(mocks.insertValues[0]).toMatchObject({
      source: 'adapter:claude-code',
      reader: 'tail-jsonl',
      issuerDid: ISSUER,
      actingFor: null,
      keyField: null,
      cadence: null,
      config: {},
      status: 'active',
    });
  });

  it('upserts on conflict, refreshing every mutable field', async () => {
    mocks.state.returningRow = { source: 'adapter:claude-code' };

    await upsertEmitter({ source: 'adapter:claude-code', reader: 'push', issuerDid: ISSUER, status: 'revoked' });

    expect(mocks.conflictSets[0]).toMatchObject({ reader: 'push', issuerDid: ISSUER, status: 'revoked' });
  });

  it('returns the upserted row', async () => {
    mocks.state.returningRow = { source: 'adapter:claude-code', reader: 'tail-jsonl' };

    await expect(
      upsertEmitter({ source: 'adapter:claude-code', reader: 'tail-jsonl', issuerDid: ISSUER }),
    ).resolves.toEqual(mocks.state.returningRow);
  });
});

describe('callerMatchesEmitter', () => {
  it('matches the issuer DID', () => {
    expect(callerMatchesEmitter({ issuerDid: ISSUER, actingFor: null }, ISSUER)).toBe(true);
  });

  it('matches the actingFor DID when present', () => {
    expect(callerMatchesEmitter({ issuerDid: ISSUER, actingFor: 'did:imajin:agent' }, 'did:imajin:agent')).toBe(true);
  });

  it('rejects a caller that is neither', () => {
    expect(callerMatchesEmitter({ issuerDid: ISSUER, actingFor: null }, 'did:imajin:someone-else')).toBe(false);
  });
});

describe('isActiveEmitter', () => {
  it('is false for undefined', () => {
    expect(isActiveEmitter(undefined)).toBe(false);
  });

  it('is false for a revoked row', () => {
    expect(isActiveEmitter({ status: 'revoked' })).toBe(false);
  });

  it('is true for an active row', () => {
    expect(isActiveEmitter({ status: 'active' })).toBe(true);
  });
});
