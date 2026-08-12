import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const {
  mockDbSelect,
  mockDbInsert,
  mockDbUpdate,
  mockFindClaimableStubDid,
  mockVerifyClaimantEmail,
} = vi.hoisted(() => ({
  mockDbSelect: vi.fn(),
  mockDbInsert: vi.fn(),
  mockDbUpdate: vi.fn(),
  mockFindClaimableStubDid: vi.fn(),
  mockVerifyClaimantEmail: vi.fn(),
}));

vi.mock('@/src/db', () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelect(...args),
    insert: (...args: unknown[]) => mockDbInsert(...args),
    update: (...args: unknown[]) => mockDbUpdate(...args),
  },
  identities: { id: 'identities.id' },
  credentials: { did: 'credentials.did', type: 'credentials.type', value: 'credentials.value' },
  identityMembers: {
    identityDid: 'identity_members.identity_did',
    memberDid: 'identity_members.member_did',
    removedAt: 'identity_members.removed_at',
  },
  onboardTokens: { token: 'onboard_tokens.token' },
  invites: { code: 'invites.code', pendingAttestationId: 'invites.pending_attestation_id' },
}));

vi.mock('@/src/lib/auth/claimable-stub', () => ({
  findClaimableStubDid: mockFindClaimableStubDid,
  verifyClaimantEmail: mockVerifyClaimantEmail,
}));

vi.mock('@imajin/config', () => ({
  buildPublicUrlAbsolute: (service: string) => `https://${service}.example`,
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

// ─── Subject ─────────────────────────────────────────────────────────────────

import { resolveOnboardIdentity, resolveOnboardRedirect } from '../onboard';

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
    mockDbSelect.mockImplementationOnce(() => selectChain(result));
  }
}

function insertChain(returning: unknown[] = []) {
  const chain: Record<string, unknown> = {};
  chain.values = vi.fn(() => chain);
  chain.returning = vi.fn(async () => returning);
  chain.then = (resolve: (v: unknown) => void) => resolve(undefined);
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDbInsert.mockImplementation(() => insertChain());
});

// ─── resolveOnboardIdentity ────────────────────────────────────────────────────

describe('resolveOnboardIdentity', () => {
  const STUB_DID = 'did:imajin:claimed-via-invite';

  it('falls back to minting a new soft DID when no claimable stub matches the email', async () => {
    mockFindClaimableStubDid.mockResolvedValue(null);
    // createOrFindSoftDid: no existing credential -> mints a new identity + credential.
    queueSelect([]);
    mockDbInsert.mockImplementationOnce(() => insertChain([{ id: 'did:imajin:new', name: null }]));
    mockDbInsert.mockImplementationOnce(() => insertChain());

    const result = await resolveOnboardIdentity('brand-new@example.com', undefined);

    expect(result.claimActivated).toBe(false);
    expect(result.created).toBe(true);
    expect(mockVerifyClaimantEmail).not.toHaveBeenCalled();
  });

  it('reuses the existing claimable stub DID and runs the claimant-verification half of the ratchet', async () => {
    mockFindClaimableStubDid.mockResolvedValue(STUB_DID);
    mockVerifyClaimantEmail.mockResolvedValue(true);
    queueSelect([{ id: STUB_DID, tier: 'preliminary', handle: null, name: null }]);

    const result = await resolveOnboardIdentity('claimed@example.com', undefined);

    expect(mockVerifyClaimantEmail).toHaveBeenCalledWith('claimed@example.com');
    expect(result.did).toBe(STUB_DID);
    expect(result.created).toBe(false);
    expect(result.claimActivated).toBe(true);
    // Never mints a second, independent DID for the same email.
    expect(mockDbInsert).not.toHaveBeenCalled();
  });

  it('reports claimActivated: false when the ratchet has not closed yet (inviter has not countersigned)', async () => {
    mockFindClaimableStubDid.mockResolvedValue(STUB_DID);
    mockVerifyClaimantEmail.mockResolvedValue(false);
    queueSelect([{ id: STUB_DID, tier: 'soft', handle: null, name: null }]);

    const result = await resolveOnboardIdentity('claimed@example.com', undefined);

    expect(result.did).toBe(STUB_DID);
    expect(result.claimActivated).toBe(false);
  });

  it('still resolves the same DID when verifyClaimantEmail rejects (non-fatal)', async () => {
    mockFindClaimableStubDid.mockResolvedValue(STUB_DID);
    mockVerifyClaimantEmail.mockRejectedValue(new Error('boom'));
    queueSelect([{ id: STUB_DID, tier: 'soft', handle: null, name: null }]);

    const result = await resolveOnboardIdentity('claimed@example.com', undefined);

    expect(result.did).toBe(STUB_DID);
    expect(result.claimActivated).toBe(false);
  });
});

// ─── resolveOnboardRedirect ────────────────────────────────────────────────────

describe('resolveOnboardRedirect', () => {
  const DEFAULT_URL = 'https://events.example/thanks';

  it('returns the default redirect when there is no invite code', async () => {
    const url = await resolveOnboardRedirect({
      inviteCode: null,
      claimActivated: true,
      defaultRedirectUrl: DEFAULT_URL,
    });

    expect(url).toBe(DEFAULT_URL);
    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  it('returns the default redirect when the ratchet did not close, even with an invite code (unweakened ratchet)', async () => {
    const url = await resolveOnboardRedirect({
      inviteCode: 'abc123',
      claimActivated: false,
      defaultRedirectUrl: DEFAULT_URL,
    });

    expect(url).toBe(DEFAULT_URL);
    // Landing here never happens on an unverified click alone — no lookup needed.
    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  it('returns the default redirect when the invite carries no pendingAttestationId', async () => {
    queueSelect([{ pendingAttestationId: null }]);

    const url = await resolveOnboardRedirect({
      inviteCode: 'abc123',
      claimActivated: true,
      defaultRedirectUrl: DEFAULT_URL,
    });

    expect(url).toBe(DEFAULT_URL);
  });

  it('routes to the attestations dashboard when the ratchet closed for an invite with a pending attestation', async () => {
    queueSelect([{ pendingAttestationId: 'att_123' }]);

    const url = await resolveOnboardRedirect({
      inviteCode: 'abc123',
      claimActivated: true,
      defaultRedirectUrl: DEFAULT_URL,
    });

    expect(url).toBe('https://auth.example/attestations?role=subject');
  });
});
