import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const {
  mockRequireAppAuth,
  mockRequireAuth,
  mockConfirmIntent,
  mockResolveIntent,
  mockGetVocabulary,
  mockDbSelect,
  mockDbFrom,
  mockDbWhere,
  mockDbLimit,
} = vi.hoisted(() => ({
  mockRequireAppAuth: vi.fn(),
  mockRequireAuth: vi.fn(),
  mockConfirmIntent: vi.fn(),
  mockResolveIntent: vi.fn(),
  mockGetVocabulary: vi.fn(),
  mockDbSelect: vi.fn(),
  mockDbFrom: vi.fn(),
  mockDbWhere: vi.fn(),
  mockDbLimit: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({
  requireAppAuth: mockRequireAppAuth,
  requireAuth: mockRequireAuth,
  resolveActingDid: (identity: { id: string; actingFor?: string }) => identity.actingFor ?? identity.id,
}));

vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({ 'Access-Control-Allow-Origin': 'https://agri.example' }),
  corsOptions: () => new Response(null, { status: 204 }),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

vi.mock('drizzle-orm', () => ({
  eq: (...args: unknown[]) => ({ eq: args }),
}));

vi.mock('@/src/db', () => ({
  db: { select: mockDbSelect },
  inferenceSessions: {},
}));

vi.mock('@/src/lib/inference/consent', () => ({
  confirmIntent: mockConfirmIntent,
}));

vi.mock('@/src/lib/inference/resolve', () => ({
  resolveIntent: mockResolveIntent,
}));

vi.mock('@/src/lib/inference/vocabulary', () => ({
  getVocabulary: mockGetVocabulary,
}));

// ─── Subject ─────────────────────────────────────────────────────────────────

import { POST, OPTIONS } from '../route';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const OWNER_DID = 'did:imajin:supplier';
const APP_DID = 'did:imajin:agrifortress-app';
const SESSION_ID = 'session_ufJq2PST8dRFPnrg';

const VOCAB = { name: 'agrifortress' };

const SESSION_ROW = {
  id: SESSION_ID,
  ownerDid: OWNER_DID,
  vocabularyName: 'agrifortress',
  status: 'pending_confirm',
};

/** App-auth denial shape returned when no app credentials are present at all. */
const NO_APP_CREDENTIALS = {
  error: 'Authorization Bearer <app-token>, or X-App-DID + X-App-Authorization headers required',
  status: 401,
};

type RouteRequest = Parameters<typeof POST>[0];

function makeReq(headers: Record<string, string> = {}): RouteRequest {
  return { headers: new Headers(headers) } as unknown as RouteRequest;
}

function makeProps() {
  return { params: Promise.resolve({ sessionId: SESSION_ID }) };
}

function appAuth(overrides: Record<string, unknown> = {}) {
  return {
    appAuth: {
      appDid: APP_DID,
      userDid: OWNER_DID,
      scopes: ['infer:provide'],
      attestationId: 'att_app',
      ...overrides,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAppAuth.mockResolvedValue(NO_APP_CREDENTIALS);
  mockRequireAuth.mockResolvedValue({ identity: { id: OWNER_DID } });
  mockConfirmIntent.mockResolvedValue(undefined);
  mockGetVocabulary.mockReturnValue(VOCAB);
  mockResolveIntent.mockResolvedValue({
    attestationId: 'attest_1',
    intentType: 'supply.received',
    primitiveType: 'supply.received',
    externalId: 'ext_1',
    resolvedAt: '2026-08-11T00:00:00.000Z',
  });

  mockDbLimit.mockResolvedValue([SESSION_ROW]);
  mockDbWhere.mockReturnValue({ limit: mockDbLimit });
  mockDbFrom.mockReturnValue({ where: mockDbWhere });
  mockDbSelect.mockReturnValue({ from: mockDbFrom });
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/inference/confirm/:sessionId — session auth', () => {
  it('confirms using the session-authenticated owner DID', async () => {
    const res = await POST(makeReq(), makeProps());

    expect(res.status).toBe(200);
    expect(mockConfirmIntent).toHaveBeenCalledWith(SESSION_ID, OWNER_DID);
    expect(mockResolveIntent).toHaveBeenCalledWith(SESSION_ID, OWNER_DID, VOCAB);
    expect(await res.json()).toEqual(
      expect.objectContaining({ status: 'resolved', attestationId: 'attest_1' }),
    );
  });

  it('honours actingFor delegation when resolving the owner DID', async () => {
    mockRequireAuth.mockResolvedValueOnce({
      identity: { id: 'did:imajin:agent', actingFor: OWNER_DID },
    });

    await POST(makeReq(), makeProps());

    expect(mockConfirmIntent).toHaveBeenCalledWith(SESSION_ID, OWNER_DID);
  });

  it('returns 401 when neither app nor session auth succeeds', async () => {
    mockRequireAuth.mockResolvedValueOnce({ error: 'Not authenticated', status: 401 });

    const res = await POST(makeReq(), makeProps());

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Not authenticated' });
    expect(mockConfirmIntent).not.toHaveBeenCalled();
  });
});

/**
 * #1782: capture accepted app-authenticated callers (Bearer app token, or
 * X-App-DID + X-App-Authorization / X-Acting-For) via `resolveInferenceAuth`,
 * but confirm only ever called `requireAuth` directly — so the exact same
 * caller that just captured a gesture was rejected with `401 Invalid token`
 * on confirm. These tests pin confirm to accept everything capture accepts.
 */
describe('POST /api/inference/confirm/:sessionId — app-authenticated caller parity with capture (#1782)', () => {
  it('confirms using the app-authenticated delegating user DID', async () => {
    mockRequireAppAuth.mockResolvedValueOnce(appAuth());

    const res = await POST(makeReq(), makeProps());

    expect(res.status).toBe(200);
    expect(mockRequireAppAuth).toHaveBeenCalledWith(expect.anything(), { scope: 'infer:provide' });
    expect(mockConfirmIntent).toHaveBeenCalledWith(SESSION_ID, OWNER_DID);
    expect(mockRequireAuth).not.toHaveBeenCalled();
  });

  it('falls back to X-Acting-For for service tokens with no delegating user', async () => {
    mockRequireAppAuth.mockResolvedValueOnce(appAuth({ userDid: '', isServiceToken: true }));

    const res = await POST(makeReq({ 'x-acting-for': OWNER_DID }), makeProps());

    expect(res.status).toBe(200);
    expect(mockConfirmIntent).toHaveBeenCalledWith(SESSION_ID, OWNER_DID);
  });

  it('rejects service tokens that name no owner DID', async () => {
    mockRequireAppAuth.mockResolvedValueOnce(appAuth({ userDid: '', isServiceToken: true }));

    const res = await POST(makeReq(), makeProps());

    expect(res.status).toBe(400);
    expect(mockConfirmIntent).not.toHaveBeenCalled();
  });

  it('surfaces the app scope denial rather than falling back to session auth', async () => {
    mockRequireAppAuth.mockResolvedValueOnce({
      error: "Scope 'infer:provide' was not granted",
      status: 403,
    });
    mockRequireAuth.mockResolvedValueOnce({ error: 'Not authenticated', status: 401 });

    const res = await POST(makeReq(), makeProps());

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Scope 'infer:provide' was not granted" });
    expect(mockConfirmIntent).not.toHaveBeenCalled();
  });

  it('surfaces the app auth error when app headers were supplied but invalid — not a generic 401 Invalid token', async () => {
    mockRequireAppAuth.mockResolvedValueOnce({ error: 'Invalid app token', status: 401 });
    mockRequireAuth.mockResolvedValueOnce({ error: 'Not authenticated', status: 401 });

    const res = await POST(makeReq({ 'x-app-did': APP_DID }), makeProps());

    expect(await res.json()).toEqual({ error: 'Invalid app token' });
  });
});

describe('POST /api/inference/confirm/:sessionId — pipeline outcomes', () => {
  it('returns 400 when the session belongs to a different owner (ownership mismatch)', async () => {
    mockConfirmIntent.mockRejectedValueOnce(new Error('Session owner mismatch'));

    const res = await POST(makeReq(), makeProps());

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Error: Session owner mismatch' });
    expect(mockResolveIntent).not.toHaveBeenCalled();
  });

  it('returns 404 when the session cannot be found after confirming', async () => {
    mockDbLimit.mockResolvedValueOnce([]);

    const res = await POST(makeReq(), makeProps());

    expect(res.status).toBe(404);
  });

  it('returns 500 when the session vocabulary is not registered', async () => {
    mockGetVocabulary.mockReturnValueOnce(undefined);

    const res = await POST(makeReq(), makeProps());

    expect(res.status).toBe(500);
  });

  it('answers CORS pre-flight', async () => {
    const res = await OPTIONS(makeReq());
    expect(res.status).toBe(204);
  });
});
