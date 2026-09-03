/**
 * Unit tests for the extracted agent-identity minting primitive (#1933).
 * `POST /auth/api/agents/route.test.ts` covers this indirectly through the
 * route, but these tests exercise `validateHandle`/`mintAgentIdentity`
 * directly so every validation and conflict branch is unit-covered too.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDbSelect, mockTxInsertValues, mockTransaction, pushSelectResult, resetSelectQueue } = vi.hoisted(() => {
  let queue: unknown[][] = [];
  const pushSelectResult = (rows: unknown[]) => queue.push(rows);
  const resetSelectQueue = () => {
    queue = [];
  };

  const mockSelectWhere = vi.fn(() => ({
    limit: (n: number) => Promise.resolve((queue.length > 0 ? queue.shift()! : []).slice(0, n)),
  }));
  const mockDbSelect = vi.fn(() => ({
    from: vi.fn(() => ({ where: mockSelectWhere })),
  }));

  const mockTxInsertValues = vi.fn().mockResolvedValue(undefined);
  const mockTransaction = vi.fn(async (fn: (tx: unknown) => Promise<void>) => {
    const tx = { insert: vi.fn(() => ({ values: mockTxInsertValues })) };
    return fn(tx);
  });

  return { mockDbSelect, mockTxInsertValues, mockTransaction, pushSelectResult, resetSelectQueue };
});

vi.mock('@/src/db', () => ({
  db: { select: mockDbSelect, transaction: mockTransaction },
  identities: { id: 'identities.id', handle: 'identities.handle' },
  identityMembers: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: (...args: unknown[]) => ({ eq: args }),
}));

vi.mock('@imajin/auth', () => ({
  generateKeypair: () => ({ privateKey: 'priv-hex', publicKey: 'pub-hex' }),
}));

vi.mock('@/src/lib/auth/crypto', () => ({
  didFromPublicKey: (publicKey: string) => `did:imajin:${publicKey}`,
}));

import { mintAgentIdentity, validateHandle, MintAgentIdentityError } from '../agent-identity';

const ACTING_DID = 'did:imajin:ryan';

beforeEach(() => {
  vi.clearAllMocks();
  resetSelectQueue();
  mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
    const tx = { insert: vi.fn(() => ({ values: mockTxInsertValues })) };
    return fn(tx);
  });
});

describe('validateHandle', () => {
  it('throws a 400 MintAgentIdentityError when handle is missing', () => {
    expect(() => validateHandle(undefined)).toThrow(MintAgentIdentityError);
    try {
      validateHandle('');
    } catch (err) {
      expect(err).toBeInstanceOf(MintAgentIdentityError);
      expect((err as MintAgentIdentityError).status).toBe(400);
      expect((err as MintAgentIdentityError).message).toBe('handle is required');
    }
  });

  it('throws a 400 error when handle is not a string', () => {
    expect(() => validateHandle(123)).toThrow(MintAgentIdentityError);
  });

  it('throws a 400 error when handle is too short', () => {
    expect(() => validateHandle('ab')).toThrow('Handle must be 3-64 characters');
  });

  it('throws a 400 error when handle is too long', () => {
    expect(() => validateHandle('a'.repeat(65))).toThrow('Handle must be 3-64 characters');
  });

  it('throws a 400 error when handle contains invalid characters', () => {
    expect(() => validateHandle('Travel Agent!')).toThrow(
      'Handle must be lowercase letters, numbers, underscores, or hyphens',
    );
  });

  it('accepts a valid handle without throwing', () => {
    expect(() => validateHandle('travel-agent_1')).not.toThrow();
  });
});

describe('mintAgentIdentity', () => {
  it('throws a 409 MintAgentIdentityError when the handle is already taken', async () => {
    pushSelectResult([{ id: 'existing' }]);

    await expect(mintAgentIdentity({ handle: 'taken-handle', actingDid: ACTING_DID })).rejects.toMatchObject({
      status: 409,
      message: 'Handle already taken',
    });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('propagates validation errors before touching the database', async () => {
    await expect(mintAgentIdentity({ handle: 'ab', actingDid: ACTING_DID })).rejects.toThrow(
      'Handle must be 3-64 characters',
    );
    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  it('mints a new identity with trimmed display name and bio metadata', async () => {
    pushSelectResult([]);

    const result = await mintAgentIdentity({
      handle: 'travel-agent',
      displayName: '  Travel Agent  ',
      bio: '  Helps plan trips  ',
      actingDid: ACTING_DID,
    });

    expect(result.did).toBe('did:imajin:pub-hex');
    expect(result.handle).toBe('travel-agent');
    expect(result.displayName).toBe('Travel Agent');
    expect(result.keypair).toEqual({ privateKey: 'priv-hex', publicKey: 'pub-hex' });
    expect(typeof result.createdAt).toBe('string');

    expect(mockTransaction).toHaveBeenCalledOnce();
    const identityRow = mockTxInsertValues.mock.calls[0][0] as Record<string, unknown>;
    expect(identityRow.metadata).toEqual({ bio: 'Helps plan trips' });
    const ownerRow = mockTxInsertValues.mock.calls[1][0] as Record<string, unknown>;
    expect(ownerRow.memberDid).toBe(ACTING_DID);
    expect(ownerRow.role).toBe('owner');
    const reverseRow = mockTxInsertValues.mock.calls[2][0] as Record<string, unknown>;
    expect(reverseRow.identityDid).toBe(ACTING_DID);
    expect(reverseRow.role).toBe('agent');
  });

  it('defaults displayName to null and metadata to {} when neither is provided', async () => {
    pushSelectResult([]);

    const result = await mintAgentIdentity({ handle: 'no-frills-agent', actingDid: ACTING_DID });

    expect(result.displayName).toBeNull();
    const identityRow = mockTxInsertValues.mock.calls[0][0] as Record<string, unknown>;
    expect(identityRow.metadata).toEqual({});
  });
});
