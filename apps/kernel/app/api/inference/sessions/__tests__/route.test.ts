import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockRequireAuth, mockDbSelect, mockSelectWhere, mockSelectLimit } = vi.hoisted(() => {
  const mockSelectLimit = vi.fn().mockResolvedValue([]);
  const mockSelectOrderBy = vi.fn(() => ({ limit: mockSelectLimit }));
  const mockSelectWhere = vi.fn(() => ({ orderBy: mockSelectOrderBy }));
  const mockSelectFrom = vi.fn(() => ({ where: mockSelectWhere }));
  const mockDbSelect = vi.fn(() => ({ from: mockSelectFrom }));
  return { mockRequireAuth: vi.fn(), mockDbSelect, mockSelectWhere, mockSelectLimit };
});

vi.mock('@/src/db', () => ({
  db: { select: mockDbSelect },
  inferenceSessions: {
    id: 'id',
    ownerDid: 'owner_did',
    appDid: 'app_did',
    vocabularyName: 'vocabulary_name',
    assetId: 'asset_id',
    chosenIntentType: 'chosen_intent_type',
    consentTier: 'consent_tier',
    status: 'status',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ and: args }),
  eq: (...args: unknown[]) => ({ eq: args }),
  desc: (col: unknown) => ({ desc: col }),
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: mockRequireAuth,
  resolveActingDid: (identity: { id: string }) => identity.id,
}));

vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({ 'Access-Control-Allow-Origin': 'https://agri.example' }),
  corsOptions: () => new Response(null, { status: 204 }),
}));

// ─── Subject ──────────────────────────────────────────────────────────────────

import { GET, OPTIONS } from '../route';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const OWNER_DID = 'did:imajin:supplier';
const BASE_URL = 'https://test.imajin.ai/api/inference/sessions';

type RouteRequest = Parameters<typeof GET>[0];

function makeReq(url = BASE_URL): RouteRequest {
  return { url, headers: new Headers() } as unknown as RouteRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAuth.mockResolvedValue({ identity: { id: OWNER_DID } });
  mockSelectLimit.mockResolvedValue([]);
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/inference/sessions', () => {
  it('returns 401 when unauthenticated', async () => {
    mockRequireAuth.mockResolvedValueOnce({ error: 'Not authenticated', status: 401 });

    const res = await GET(makeReq());

    expect(res.status).toBe(401);
    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  it('projects the credential-providing app DID alongside the session (#1624)', async () => {
    mockSelectLimit.mockResolvedValueOnce([
      { id: 'session_abc', appDid: 'did:imajin:agrifortress-app', status: 'resolved' },
    ]);

    const res = await GET(makeReq());

    expect(res.status).toBe(200);
    const projection = mockDbSelect.mock.calls[0][0] as Record<string, unknown>;
    expect(projection).toHaveProperty('appDid');

    const body = await res.json() as { count: number; sessions: { appDid: string }[] };
    expect(body.count).toBe(1);
    expect(body.sessions[0].appDid).toBe('did:imajin:agrifortress-app');
  });

  it('scopes the listing to the acting owner DID', async () => {
    await GET(makeReq());

    expect(mockSelectWhere).toHaveBeenCalledWith({ eq: ['owner_did', OWNER_DID] });
  });

  it('adds a status filter when requested', async () => {
    await GET(makeReq(`${BASE_URL}?status=pending_confirm`));

    expect(mockSelectWhere).toHaveBeenCalledWith({
      and: [{ eq: ['owner_did', OWNER_DID] }, { eq: ['status', 'pending_confirm'] }],
    });
  });

  it('caps the limit at 200', async () => {
    await GET(makeReq(`${BASE_URL}?limit=9999`));

    expect(mockSelectLimit).toHaveBeenCalledWith(200);
  });

  it('answers CORS pre-flight', async () => {
    const res = await OPTIONS(makeReq());
    expect(res.status).toBe(204);
  });
});
