import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const {
  mockSelect,
  mockInsert,
  mockUpdate,
  mockPublish,
  mockConsumePendingInvites,
  mockMintOrAccrueClaimableStub,
  mockRateLimit,
} = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockInsert: vi.fn(),
  mockUpdate: vi.fn(),
  mockPublish: vi.fn(async () => undefined),
  mockConsumePendingInvites: vi.fn(async () => undefined),
  mockMintOrAccrueClaimableStub: vi.fn(),
  mockRateLimit: vi.fn(() => ({ limited: false, retryAfter: 0 })),
}));

vi.mock('@/src/db', () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
    insert: (...args: unknown[]) => mockInsert(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
  },
  identities: { id: 'identities.id' },
  credentials: { did: 'credentials.did', type: 'credentials.type', value: 'credentials.value' },
}));

vi.mock('@/src/lib/auth/claimable-stub', () => ({
  mintOrAccrueClaimableStub: mockMintOrAccrueClaimableStub,
}));

vi.mock('@/src/lib/auth/consume-invite', () => ({
  consumePendingInvites: mockConsumePendingInvites,
}));

vi.mock('@imajin/bus', () => ({
  publish: mockPublish,
}));

vi.mock('@imajin/config', () => ({
  rateLimit: mockRateLimit,
  getClientIP: () => '127.0.0.1',
  corsHeaders: () => ({}),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

// ─── Subject ─────────────────────────────────────────────────────────────────

import { POST } from '../route';

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

function makeRequest(body: Record<string, unknown>): Parameters<typeof POST>[0] {
  return {
    headers: new Headers(),
    json: async () => body,
  } as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRateLimit.mockReturnValue({ limited: false, retryAfter: 0 });
  mockInsert.mockImplementation(() => insertChain());
  mockUpdate.mockImplementation(() => updateChain());
});

describe('POST /api/session/soft — folded onto the claimable-stub primitive (#1834 Phase 3)', () => {
  it('mints via the primitive for a new email and fires identity.created + consumePendingInvites', async () => {
    const did = 'did:imajin:new-checkout-stub';
    queueSelect(
      [], // no existing credential
      [{ id: did, handle: null, scope: 'actor', subtype: 'human', name: null, contactEmail: null }],
    );
    mockMintOrAccrueClaimableStub.mockResolvedValueOnce({ did, isNewStub: true });
    mockUpdate.mockImplementationOnce(() =>
      updateChain([{ id: did, handle: null, scope: 'actor', subtype: 'human', name: 'Buyer', contactEmail: 'buyer@example.com' }]),
    );

    const res = await POST(makeRequest({ email: 'Buyer@Example.com', name: 'Buyer' }));
    const body = await res.json();

    expect(mockMintOrAccrueClaimableStub).toHaveBeenCalledWith('buyer@example.com');
    expect(body.did).toBe(did);
    expect(body.tier).toBe('soft');
    expect(mockPublish).toHaveBeenCalledWith('identity.created', expect.objectContaining({ subject: did }));
    expect(mockConsumePendingInvites).toHaveBeenCalledWith({ did, email: 'buyer@example.com' });

    // No plaintext-searchable credentials row is inserted for the unverified stub.
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('accrues to a stub already minted elsewhere (e.g. a connections invite) without re-firing identity.created', async () => {
    const did = 'did:imajin:from-invite';
    queueSelect(
      [], // no existing credential — the invite-minted stub never got one
      [{ id: did, handle: null, scope: 'actor', subtype: 'human', name: null, contactEmail: 'invitee@example.com' }],
    );
    mockMintOrAccrueClaimableStub.mockResolvedValueOnce({ did, isNewStub: false });

    const res = await POST(makeRequest({ email: 'invitee@example.com' }));
    const body = await res.json();

    expect(body.did).toBe(did);
    expect(mockPublish).not.toHaveBeenCalled();
    // Still worth re-checking for any other pending invites tied to this email/DID.
    expect(mockConsumePendingInvites).toHaveBeenCalledWith({ did, email: 'invitee@example.com' });
  });

  it('reuses the existing identity without calling the primitive once a verified credential exists', async () => {
    const did = 'did:imajin:already-verified';
    queueSelect(
      [{ did }], // credentials hit
      [{ id: did, handle: 'somebody', scope: 'actor', subtype: 'human', name: 'Somebody', contactEmail: 'somebody@example.com' }],
    );

    const res = await POST(makeRequest({ email: 'somebody@example.com' }));
    const body = await res.json();

    expect(body.did).toBe(did);
    expect(mockMintOrAccrueClaimableStub).not.toHaveBeenCalled();
  });

  it('rejects an invalid email before touching the database', async () => {
    const res = await POST(makeRequest({ email: 'not-an-email' }));

    expect(res.status).toBe(400);
    expect(mockMintOrAccrueClaimableStub).not.toHaveBeenCalled();
  });
});
