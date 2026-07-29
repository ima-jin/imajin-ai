import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────
// vi.mock factories are hoisted; all referenced variables must come from vi.hoisted.

// Mock next/server — not available outside Next.js runtime.
vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
      }),
  },
}));

const {
  mockDbSelect,
  mockSelectLimit,
  mockInsert,
  mockMembersInsertValues,
  mockDbUpdate,
  mockUpdateSet,
  mockRequireAuth,
  mockRequireAppAuth,
  mockResolveOrMintIdentity,
  mockPublish,
} = vi.hoisted(() => {
  const mockSelectLimit    = vi.fn().mockResolvedValue([]);
  const mockSelectWhere    = vi.fn(() => ({ limit: mockSelectLimit }));
  const mockSelectFrom     = vi.fn(() => ({ where: mockSelectWhere }));
  const mockDbSelect       = vi.fn(() => ({ from: mockSelectFrom }));

  const mockMembersInsertValues = vi.fn().mockResolvedValue(undefined);
  const mockInsert              = vi.fn(() => ({ values: mockMembersInsertValues }));

  const mockUpdateWhere = vi.fn().mockResolvedValue(undefined);
  const mockUpdateSet   = vi.fn(() => ({ where: mockUpdateWhere }));
  const mockDbUpdate    = vi.fn(() => ({ set: mockUpdateSet }));

  // requireAppAuth returns a non-403 error by default → falls through to requireAuth
  const mockRequireAppAuth      = vi.fn().mockResolvedValue({ error: 'Not an app token', status: 401 });
  const mockRequireAuth         = vi.fn();
  const mockResolveOrMintIdentity = vi.fn();
  const mockPublish             = vi.fn().mockResolvedValue(undefined);

  return {
    mockDbSelect,
    mockSelectLimit,
    mockInsert,
    mockMembersInsertValues,
    mockDbUpdate,
    mockUpdateSet,
    mockRequireAuth,
    mockRequireAppAuth,
    mockResolveOrMintIdentity,
    mockPublish,
  };
});

vi.mock('@/src/db', () => ({
  db: {
    select: mockDbSelect,
    insert: mockInsert,
    update: mockDbUpdate,
  },
  identities: {},
  identityAliases: {},
  identityMembers: {},
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ and: args }),
  eq:  (...args: unknown[]) => ({ eq: args }),
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: mockRequireAuth,
  requireAppAuth: mockRequireAppAuth,
  resolveActingDid: (identity: { actingFor?: string; actingAs?: string; id: string }) =>
    identity.actingFor ?? identity.actingAs ?? identity.id,
}));

vi.mock('@imajin/bus', () => ({
  publish: mockPublish,
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

vi.mock('nanoid', () => ({ nanoid: () => 'test-nanoid-44' }));

vi.mock('@/src/lib/registry/identity-alias', () => ({
  resolveOrMintIdentity: mockResolveOrMintIdentity,
  isResolveIdentityError: (r: unknown) =>
    typeof r === 'object' && r !== null && 'error' in r,
}));

// ─── Subject under test ──────────────────────────────────────────────────────

import { POST } from '../route';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const APP_DID     = 'did:imajin:app-tripian';
const TRAVELER_DID = 'did:imajin:traveler-abc';
const BASE_URL    = 'https://test.imajin.ai/registry/api/identity';

const MINT_RESULT = {
  did: TRAVELER_DID,
  created: true,
  metadata: { type: 'traveler' },
  minted: true,
};

function makeRequest(body: Record<string, unknown>): Request {
  return new Request(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAuth.mockResolvedValue({ identity: { id: APP_DID } });
  mockResolveOrMintIdentity.mockResolvedValue(MINT_RESULT);
  mockSelectLimit.mockResolvedValue([]);        // no pre-existing agent grant
  mockMembersInsertValues.mockResolvedValue(undefined);
  mockPublish.mockResolvedValue(undefined);
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('POST /registry/api/identity — agent grant bootstrap (#1442)', () => {
  // Scenario 1: no optInRef → no grant recorded
  describe('without optInRef', () => {
    it('returns 201 and does NOT record an agent grant', async () => {
      const req = makeRequest({ namespace: 'tripian', ref: 'traveler:1', type: 'traveler' });
      const res = await POST(req);

      expect(res.status).toBe(201);
      // db.insert must not have been called — no agent grant, no alias/identity rows
      // (those are handled by the mocked resolveOrMintIdentity)
      expect(mockInsert).not.toHaveBeenCalled();
    });
  });

  // Validation: empty-string optInRef
  it('rejects an empty-string optInRef with 400', async () => {
    const req = makeRequest({ namespace: 'tripian', ref: 'traveler:1', type: 'traveler', optInRef: '   ' });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/optInRef/);
  });

  // Scenario 2: optInRef present → agent grant inserted
  describe('with optInRef', () => {
    it('inserts an agent-role identity_members row', async () => {
      const req = makeRequest({
        namespace: 'tripian',
        ref: 'traveler:1',
        type: 'traveler',
        optInRef: 'optin-ref-abc123',
      });
      const res = await POST(req);

      expect(res.status).toBe(201);
      expect(mockInsert).toHaveBeenCalledOnce();
      const row = mockMembersInsertValues.mock.calls[0][0] as Record<string, unknown>;
      expect(row.identityDid).toBe(TRAVELER_DID);
      expect(row.memberDid).toBe(APP_DID);
      expect(row.role).toBe('agent');
      expect(row.addedBy).toBe(APP_DID);
      expect(row.optInRef).toBe('optin-ref-abc123');
    });

    it('is idempotent: skips insert when an active grant already exists (removedAt = null)', async () => {
      mockSelectLimit.mockResolvedValueOnce([{ removedAt: null }]);

      const req = makeRequest({
        namespace: 'tripian',
        ref: 'traveler:1',
        type: 'traveler',
        optInRef: 'optin-ref-abc123',
      });
      const res = await POST(req);

      expect(res.status).toBe(201);
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it('reactivates a previously revoked grant via update', async () => {
      const removedAt = new Date('2026-01-01');
      mockSelectLimit.mockResolvedValueOnce([{ removedAt }]);

      const req = makeRequest({
        namespace: 'tripian',
        ref: 'traveler:1',
        type: 'traveler',
        optInRef: 'optin-ref-abc123',
      });
      const res = await POST(req);

      expect(res.status).toBe(201);
      expect(mockInsert).not.toHaveBeenCalled();
      expect(mockDbUpdate).toHaveBeenCalledOnce();
      const setArgs = mockUpdateSet.mock.calls[0][0] as Record<string, unknown>;
      expect(setArgs.removedAt).toBeNull();
      expect(setArgs.role).toBe('agent');
      expect(setArgs.optInRef).toBe('optin-ref-abc123');
    });
  });
});
