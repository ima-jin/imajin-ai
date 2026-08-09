import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const {
  mockIdentityInsertValues,
  mockIdentityInsertOnConflict,
  mockMembershipInsertValues,
  mockMembershipSelectLimit,
  mockTxInsert,
  mockTxSelect,
  mockTransaction,
  mockLogError,
} = vi.hoisted(() => {
  const mockIdentityInsertOnConflict = vi.fn().mockResolvedValue(undefined);
  const mockIdentityInsertValues = vi.fn(() => ({ onConflictDoNothing: mockIdentityInsertOnConflict }));

  const mockMembershipInsertValues = vi.fn().mockResolvedValue(undefined);
  const mockMembershipSelectLimit = vi.fn().mockResolvedValue([]);

  const mockTxInsert = vi.fn((table: unknown) => {
    if (table === 'identities') return { values: mockIdentityInsertValues };
    return { values: mockMembershipInsertValues };
  });
  const mockTxSelect = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({ limit: mockMembershipSelectLimit })),
    })),
  }));

  const mockTransaction = vi.fn(async (fn: (tx: unknown) => Promise<void>) => {
    const tx = { insert: mockTxInsert, select: mockTxSelect };
    return fn(tx);
  });

  const mockLogError = vi.fn();

  return {
    mockIdentityInsertValues,
    mockIdentityInsertOnConflict,
    mockMembershipInsertValues,
    mockMembershipSelectLimit,
    mockTxInsert,
    mockTxSelect,
    mockTransaction,
    mockLogError,
  };
});

vi.mock('@/src/db', () => ({
  db: { transaction: mockTransaction },
  identities: 'identities',
  identityMembers: 'identityMembers',
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ and: args }),
  eq: (...args: unknown[]) => ({ eq: args }),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: mockLogError, info: vi.fn(), warn: vi.fn() }),
}));

// ─── Subject under test ─────────────────────────────────────────────────────

import { promoteActorOnGrant } from '../promote-actor';

const INPUT = {
  appId: 'app_4MbCYrndTWiJjMPe',
  appDid: 'did:imajin:wjLjV7nSWNZLTUqnhKRUiBrnGG8mKK7q9WXpNEnV2SM',
  publicKey: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9',
  ownerDid: 'did:imajin:agrifortress',
  name: 'AgriFortress App',
  avatarUrl: null,
  adapter: 'keypair',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockIdentityInsertOnConflict.mockResolvedValue(undefined);
  mockMembershipInsertValues.mockResolvedValue(undefined);
  mockMembershipSelectLimit.mockResolvedValue([]);
  mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
    const tx = { insert: mockTxInsert, select: mockTxSelect };
    return fn(tx);
  });
});

describe('promoteActorOnGrant (#1735)', () => {
  it('inserts the identity row with the real public key (not a sentinel)', async () => {
    await promoteActorOnGrant(INPUT);

    expect(mockIdentityInsertValues).toHaveBeenCalledOnce();
    const row = mockIdentityInsertValues.mock.calls[0][0] as Record<string, unknown>;
    expect(row.publicKey).toBe(INPUT.publicKey);
    expect(row.publicKey).not.toMatch(/^agent_/);
    expect(row.id).toBe(INPUT.appDid);
  });

  it('creates both identity_members rows linking the actor to the granting DID', async () => {
    await promoteActorOnGrant(INPUT);

    expect(mockMembershipInsertValues).toHaveBeenCalledTimes(2);
    const rows = mockMembershipInsertValues.mock.calls.map(c => c[0] as Record<string, unknown>);

    const ownerRow = rows.find(r => r.role === 'owner');
    expect(ownerRow).toMatchObject({
      identityDid: INPUT.appDid,
      memberDid: INPUT.ownerDid,
      role: 'owner',
    });

    const agentRow = rows.find(r => r.role === 'agent');
    expect(agentRow).toMatchObject({
      identityDid: INPUT.ownerDid,
      memberDid: INPUT.appDid,
      role: 'agent',
    });
  });

  it('does everything inside a single transaction', async () => {
    await promoteActorOnGrant(INPUT);
    expect(mockTransaction).toHaveBeenCalledOnce();
  });

  it('is idempotent: skips membership inserts that already exist (re-consent)', async () => {
    mockMembershipSelectLimit.mockResolvedValue([{ identityDid: 'already-there' }]);

    await promoteActorOnGrant(INPUT);

    expect(mockMembershipInsertValues).not.toHaveBeenCalled();
    // Identity insert still runs (guarded by ON CONFLICT DO NOTHING at the DB level).
    expect(mockIdentityInsertValues).toHaveBeenCalledOnce();
  });

  it('is non-fatal: swallows and logs errors instead of throwing', async () => {
    mockTransaction.mockRejectedValueOnce(new Error('db exploded'));

    await expect(promoteActorOnGrant(INPUT)).resolves.toBeUndefined();
    expect(mockLogError).toHaveBeenCalledOnce();
  });
});
