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
  mockRequireAppAuth,
  mockRequireAuth,
  mockResolveOrMintIdentity,
  mockPublish,
} = vi.hoisted(() => {
  const mockRequireAppAuth       = vi.fn();
  const mockRequireAuth          = vi.fn();
  const mockResolveOrMintIdentity = vi.fn();
  const mockPublish              = vi.fn().mockResolvedValue(undefined);

  return {
    mockRequireAppAuth,
    mockRequireAuth,
    mockResolveOrMintIdentity,
    mockPublish,
  };
});

vi.mock('@/src/db', () => ({
  db: {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([]) })) })) })),
    insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) })),
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
  requireAppAuth: mockRequireAppAuth,
  requireAuth: mockRequireAuth,
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

const APP_DID      = 'did:imajin:app-tripian';
const USER_DID     = 'did:imajin:user-mehmet';
const TRAVELER_DID = 'did:imajin:traveler-abc';
const BASE_URL     = 'https://test.imajin.ai/registry/api/identity';

const MINT_RESULT = {
  did: TRAVELER_DID,
  created: true,
  metadata: { type: 'traveler' },
  minted: true,
};

const RESOLVE_RESULT = {
  did: TRAVELER_DID,
  created: false,
  metadata: { type: 'traveler' },
  minted: false,
};

function makeRequest(body: Record<string, unknown>): Request {
  return new Request(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer some-token' },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = { namespace: 'tripian', ref: 'traveler:1', type: 'traveler' };

beforeEach(() => {
  vi.clearAllMocks();
  // Default: requireAppAuth returns 401 (no app token) → falls through to session auth
  mockRequireAppAuth.mockResolvedValue({ error: 'Authorization Bearer <app-token>, or X-App-DID + X-App-Authorization headers required', status: 401 });
  // Default: requireAuth succeeds with a session user
  mockRequireAuth.mockResolvedValue({ identity: { id: USER_DID } });
  mockResolveOrMintIdentity.mockResolvedValue(MINT_RESULT);
  mockPublish.mockResolvedValue(undefined);
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('POST /registry/api/identity — dual-mode auth (Issue #1464)', () => {

  // ── App-tier path ─────────────────────────────────────────────────────────

  describe('app-service JWT with identity:write scope', () => {
    beforeEach(() => {
      mockRequireAppAuth.mockResolvedValue({
        appAuth: { appDid: APP_DID, userDid: '', scopes: ['identity:write'], attestationId: '', isServiceToken: true },
      });
    });

    it('returns 201 when the identity is minted', async () => {
      const res = await POST(makeRequest(VALID_BODY));
      expect(res.status).toBe(201);
    });

    it('returns 200 when the identity already exists (no mint)', async () => {
      mockResolveOrMintIdentity.mockResolvedValueOnce(RESOLVE_RESULT);
      const res = await POST(makeRequest(VALID_BODY));
      expect(res.status).toBe(200);
    });

    it('uses the appDid as the identity.created issuer (not userDid)', async () => {
      await POST(makeRequest(VALID_BODY));
      expect(mockPublish).toHaveBeenCalledOnce();
      const [, event] = mockPublish.mock.calls[0] as [string, { issuer: string }];
      expect(event.issuer).toBe(APP_DID);
    });

    it('does NOT call requireAuth', async () => {
      await POST(makeRequest(VALID_BODY));
      expect(mockRequireAuth).not.toHaveBeenCalled();
    });
  });

  // ── Scope-gate: 403 for valid token lacking identity:write ────────────────

  describe('app-service JWT lacking identity:write scope', () => {
    beforeEach(() => {
      mockRequireAppAuth.mockResolvedValue({ error: 'Insufficient scope', status: 403 });
    });

    it('returns 403 without falling through to session auth', async () => {
      const res = await POST(makeRequest(VALID_BODY));
      expect(res.status).toBe(403);
      const body = await res.json() as { error: string };
      expect(body.error).toBe('Insufficient scope');
    });

    it('does NOT call requireAuth', async () => {
      await POST(makeRequest(VALID_BODY));
      expect(mockRequireAuth).not.toHaveBeenCalled();
    });
  });

  // ── Session/user path ─────────────────────────────────────────────────────

  describe('session/user auth path (requireAppAuth returns non-403 error)', () => {
    it('returns 201 via the session path when requireAuth succeeds', async () => {
      const res = await POST(makeRequest(VALID_BODY));
      expect(res.status).toBe(201);
    });

    it('uses the session identity DID as issuer, not an appDid', async () => {
      await POST(makeRequest(VALID_BODY));
      const [, event] = mockPublish.mock.calls[0] as [string, { issuer: string }];
      expect(event.issuer).toBe(USER_DID);
    });

    it('returns 401 when session auth also fails', async () => {
      mockRequireAuth.mockResolvedValueOnce({ error: 'Not authenticated', status: 401 });
      const res = await POST(makeRequest(VALID_BODY));
      expect(res.status).toBe(401);
    });

    it('does not publish when the identity already exists', async () => {
      mockResolveOrMintIdentity.mockResolvedValueOnce(RESOLVE_RESULT);
      const res = await POST(makeRequest(VALID_BODY));
      expect(res.status).toBe(200);
      expect(mockPublish).not.toHaveBeenCalled();
    });
  });

  // ── Body validation (shared by both auth paths) ───────────────────────────

  describe('body validation', () => {
    it('returns 400 when namespace is missing', async () => {
      const res = await POST(makeRequest({ ref: 'traveler:1', type: 'traveler' }));
      expect(res.status).toBe(400);
    });

    it('returns 400 when ref is missing', async () => {
      const res = await POST(makeRequest({ namespace: 'tripian', type: 'traveler' }));
      expect(res.status).toBe(400);
    });

    it('returns 400 when type is missing', async () => {
      const res = await POST(makeRequest({ namespace: 'tripian', ref: 'traveler:1' }));
      expect(res.status).toBe(400);
    });
  });
});
