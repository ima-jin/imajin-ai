import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────────────
//
// Named `create-or-find-soft-did.test.ts` (not `onboard.test.ts`) so this file
// doesn't collide with the unmerged #1837 (Phase 2) branch, which introduces
// its own `apps/kernel/src/lib/auth/__tests__/onboard.test.ts` covering
// `resolveOnboardIdentity`/`resolveOnboardRedirect`.

const { mockSelect, mockInsert, mockUpdate, mockMintOrAccrueClaimableStub } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockInsert: vi.fn(),
  mockUpdate: vi.fn(),
  mockMintOrAccrueClaimableStub: vi.fn(),
}));

vi.mock('@/src/db', () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
    insert: (...args: unknown[]) => mockInsert(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
  },
  identities: { id: 'identities.id' },
  credentials: { did: 'credentials.did', type: 'credentials.type', value: 'credentials.value' },
  identityMembers: {
    identityDid: 'identity_members.identity_did',
    memberDid: 'identity_members.member_did',
    removedAt: 'identity_members.removed_at',
  },
  onboardTokens: { token: 'onboard_tokens.token' },
}));

vi.mock('@/src/lib/auth/claimable-stub', () => ({
  mintOrAccrueClaimableStub: mockMintOrAccrueClaimableStub,
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

// ─── Subject ─────────────────────────────────────────────────────────────────

import { createOrFindSoftDid } from '../onboard';

// ─── Test helpers ────────────────────────────────────────────────────────────

function selectChain(result: unknown) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  chain.from = vi.fn(self);
  chain.where = vi.fn(self);
  chain.limit = vi.fn(async () => result);
  chain.then = (resolve: (v: unknown) => void) => resolve(result);
  return chain;
}

function queueSelect(...results: unknown[]) {
  for (const result of results) {
    mockSelect.mockImplementationOnce(() => selectChain(result));
  }
}

function insertChain() {
  const chain: Record<string, unknown> = {};
  chain.values = vi.fn(() => chain);
  chain.onConflictDoNothing = vi.fn(async () => undefined);
  chain.returning = vi.fn(async () => []);
  chain.then = (resolve: (v: unknown) => void) => resolve(undefined);
  return chain;
}

function updateChain(returning: unknown[] = []) {
  const chain: Record<string, unknown> = {};
  chain.set = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.returning = vi.fn(async () => returning);
  chain.then = (resolve: (v: unknown) => void) => resolve(undefined);
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockInsert.mockImplementation(() => insertChain());
  mockUpdate.mockImplementation(() => updateChain());
});

describe('createOrFindSoftDid — folded onto the claimable-stub primitive (#1834 Phase 3)', () => {
  it('returns the existing identity without touching the primitive when a verified credential already exists', async () => {
    const existingDid = 'did:imajin:already-onboarded';
    queueSelect(
      [{ did: existingDid }], // credentials hit
      [{ id: existingDid, name: 'Existing', contactEmail: 'existing@example.com' }], // identities hit
    );

    const result = await createOrFindSoftDid('existing@example.com', 'Existing');

    expect(result.did).toBe(existingDid);
    expect(result.created).toBe(false);
    expect(mockMintOrAccrueClaimableStub).not.toHaveBeenCalled();
  });

  it('mints via the primitive for a genuinely new email and inserts a verified credential (self-serve = immediate verification)', async () => {
    const newDid = 'did:imajin:brand-new-stub';
    queueSelect(
      [], // no existing credential
      [{ id: newDid, name: null, contactEmail: null }], // identity the primitive just minted
    );
    mockMintOrAccrueClaimableStub.mockResolvedValueOnce({ did: newDid, isNewStub: true });
    mockUpdate.mockImplementationOnce(() =>
      updateChain([{ id: newDid, name: 'New Person', contactEmail: 'new@example.com' }]),
    );

    const result = await createOrFindSoftDid('new@example.com', 'New Person');

    expect(mockMintOrAccrueClaimableStub).toHaveBeenCalledWith('new@example.com');
    expect(result.did).toBe(newDid);
    expect(result.created).toBe(true);

    // Verified credential inserted unconditionally — click IS the verification.
    expect(mockInsert).toHaveBeenCalled();
    const values = (mockInsert.mock.results.at(-1)?.value as ReturnType<typeof insertChain>).values;
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ did: newDid, type: 'email', value: 'new@example.com', verifiedAt: expect.any(Date) }),
    );
  });

  it('accrues to a stub already minted by a different site (e.g. events checkout) instead of minting a second DID', async () => {
    const accruedDid = 'did:imajin:from-checkout';
    queueSelect(
      [], // no verified credential yet — the stub from checkout never got one
      [{ id: accruedDid, name: null, contactEmail: 'shared@example.com' }],
    );
    mockMintOrAccrueClaimableStub.mockResolvedValueOnce({ did: accruedDid, isNewStub: false });
    // Already has a contactEmail from the checkout mint, and no name is
    // supplied here, so neither backfill condition triggers an update.

    const result = await createOrFindSoftDid('shared@example.com', null);

    expect(result.did).toBe(accruedDid);
    // Not a fresh mint — accrual to the existing stub. Onboard's own contract
    // reports `created` from the primitive's `isNewStub`, so callers (e.g.
    // GET /api/onboard/verify) don't double-fire the identity.created welcome
    // bonus for a DID that already exists.
    expect(result.created).toBe(false);
  });

  it('throws instead of silently minting a second DID if the claim_stub_index row somehow has no backing identity', async () => {
    queueSelect(
      [],
      [], // defensive: identities lookup comes back empty
    );
    mockMintOrAccrueClaimableStub.mockResolvedValueOnce({ did: 'did:imajin:orphan', isNewStub: true });

    await expect(createOrFindSoftDid('broken@example.com', null)).rejects.toThrow(/no identities row/);
  });
});
