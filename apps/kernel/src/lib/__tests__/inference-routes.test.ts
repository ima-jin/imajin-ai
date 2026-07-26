import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

// ── Hoisted mocks (available inside vi.mock factories) ────────────────────────

const {
  requireAuthMock,
  requireAppAuthMock,
  resolveActingDidMock,
  dbLimitMock,
  captureGestureMock,
  gatherContextMock,
  inferMock,
  resolveConsentGateMock,
  resolveIntentMock,
  confirmIntentMock,
  getVocabularyMock,
  listVocabularyNamesMock,
} = vi.hoisted(() => ({
  requireAuthMock: vi.fn(),
  requireAppAuthMock: vi.fn(),
  resolveActingDidMock: vi.fn(() => 'did:imajin:session-user'),
  dbLimitMock: vi.fn(),
  captureGestureMock: vi.fn(),
  gatherContextMock: vi.fn(),
  inferMock: vi.fn(),
  resolveConsentGateMock: vi.fn(),
  resolveIntentMock: vi.fn(),
  confirmIntentMock: vi.fn(),
  getVocabularyMock: vi.fn(),
  listVocabularyNamesMock: vi.fn(() => ['imajin', 'agrifortress']),
}));

// ── Module mocks ───────────────────────────────────────────────────────────────

function mockResponseJson(body: unknown, init?: { status?: number; headers?: unknown }) {
  return { status: init?.status ?? 200, _body: body, json: async () => body };
}
vi.mock('next/server', () => ({
  NextResponse: { json: vi.fn(mockResponseJson) },
  NextRequest: class {},
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: requireAuthMock,
  requireAppAuth: requireAppAuthMock,
  resolveActingDid: resolveActingDidMock,
}));

vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({}),
  corsOptions: vi.fn(() => ({ status: 204 })),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

vi.mock('@imajin/config', () => ({
  rateLimit: vi.fn(() => ({ limited: false })),
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => 'eq'),
  and: vi.fn(() => 'and'),
  desc: vi.fn(() => 'desc'),
}));

vi.mock('@/src/db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'orderBy']) {
    chain[m] = vi.fn(() => chain);
  }
  chain['limit'] = dbLimitMock;
  return { db: chain, inferenceSessions: {} };
});

vi.mock('@/src/lib/inference/capture', () => ({ captureGesture: captureGestureMock }));
vi.mock('@/src/lib/inference/context', () => ({ gatherContext: gatherContextMock }));
vi.mock('@/src/lib/inference/policy', () => ({ infer: inferMock }));
vi.mock('@/src/lib/inference/consent', () => ({
  resolveConsentGate: resolveConsentGateMock,
  confirmIntent: confirmIntentMock,
}));
vi.mock('@/src/lib/inference/resolve', () => ({ resolveIntent: resolveIntentMock }));
vi.mock('@/src/lib/inference/vocabulary', () => ({
  getVocabulary: getVocabularyMock,
  listVocabularyNames: listVocabularyNamesMock,
}));
vi.mock('@/src/lib/media/create-asset', () => ({
  inferMime: vi.fn(() => 'audio/webm'),
  isAllowedMime: vi.fn(() => true),
}));

// ── Route handler imports (after mocks) ───────────────────────────────────────

import { GET as sessionsGet } from '../../../app/api/inference/sessions/route';
import { POST as capturePost } from '../../../app/api/inference/capture/route';
import { POST as confirmPost } from '../../../app/api/inference/confirm/[sessionId]/route';

// ── Test helpers ──────────────────────────────────────────────────────────────

const APP_DID = 'did:imajin:xprize-app';
const USER_DID = 'did:imajin:farmer-alice';
const SESSION_USER = 'did:imajin:session-user';

function grantAppWrite(opts: { userDid?: string } = {}) {
  requireAppAuthMock.mockResolvedValue({
    appAuth: { appDid: APP_DID, userDid: opts.userDid ?? USER_DID, scopes: ['inference:write'] },
  });
}

function grantAppRead(opts: { userDid?: string } = {}) {
  requireAppAuthMock.mockResolvedValue({
    appAuth: { appDid: APP_DID, userDid: opts.userDid ?? USER_DID, scopes: ['inference:read'] },
  });
}

function denyAppAuth(status = 401) {
  requireAppAuthMock.mockResolvedValue({ error: 'No valid app token', status });
}

function grantSessionAuth() {
  requireAuthMock.mockResolvedValue({ identity: { id: SESSION_USER } });
}

function denySessionAuth(status = 401) {
  requireAuthMock.mockResolvedValue({ error: 'unauthorized', status });
}

function makeRequest(opts: {
  actingFor?: string | null;
  url?: string;
  formData?: () => Promise<FormData>;
} = {}): NextRequest {
  return {
    headers: {
      get: (key: string) =>
        key === 'x-acting-for' ? (opts.actingFor ?? null) : null,
    },
    url: opts.url ?? 'http://localhost/',
    formData: opts.formData,
  } as unknown as NextRequest;
}

function makeCaptureRequest(actingFor: string | null = null): NextRequest {
  const file = new Blob(['audio-data'], { type: 'audio/webm' });
  const fd = new FormData();
  fd.append('file', file, 'recording.webm');
  return makeRequest({
    actingFor,
    url: 'http://localhost/api/inference/capture?vocabulary=imajin',
    formData: async () => fd,
  });
}

// Stub vocabulary so the capture/confirm pipeline doesn't blow up.
const FAKE_VOCAB = { name: 'imajin' };

beforeEach(() => {
  requireAuthMock.mockReset();
  requireAppAuthMock.mockReset();
  dbLimitMock.mockReset();
  captureGestureMock.mockReset();
  gatherContextMock.mockReset();
  inferMock.mockReset();
  resolveConsentGateMock.mockReset();
  resolveIntentMock.mockReset();
  confirmIntentMock.mockReset();
  getVocabularyMock.mockReset();
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/inference/sessions
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/inference/sessions — app-auth path (#1431)', () => {
  it('accepts app token + x-acting-for and returns sessions', async () => {
    grantAppRead();
    dbLimitMock.mockResolvedValue([]);

    const res = await sessionsGet(makeRequest({ actingFor: USER_DID, url: 'http://localhost/api/inference/sessions' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(0);
    expect(body.sessions).toEqual([]);
  });

  it('falls back to appAuth.userDid when x-acting-for header is absent', async () => {
    grantAppRead({ userDid: USER_DID });
    dbLimitMock.mockResolvedValue([]);

    const res = await sessionsGet(makeRequest({ actingFor: null, url: 'http://localhost/api/inference/sessions' }));
    expect(res.status).toBe(200);
  });

  it('returns 400 when app token has no userDid and x-acting-for is absent', async () => {
    requireAppAuthMock.mockResolvedValue({
      appAuth: { appDid: APP_DID, userDid: undefined, scopes: ['inference:read'] },
    });

    const res = await sessionsGet(makeRequest({ actingFor: null, url: 'http://localhost/api/inference/sessions' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('X-Acting-For');
  });

  it('falls through to session auth when app token is absent', async () => {
    denyAppAuth();
    grantSessionAuth();
    dbLimitMock.mockResolvedValue([]);

    const res = await sessionsGet(makeRequest({ url: 'http://localhost/api/inference/sessions' }));
    expect(res.status).toBe(200);
    expect(requireAuthMock).toHaveBeenCalledOnce();
  });

  it('returns 401 when neither app-auth nor session-auth succeed', async () => {
    denyAppAuth();
    denySessionAuth();

    const res = await sessionsGet(makeRequest({ url: 'http://localhost/api/inference/sessions' }));
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/inference/capture
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/inference/capture — app-auth path (#1431)', () => {
  function stubPipeline() {
    getVocabularyMock.mockReturnValue(FAKE_VOCAB);
    captureGestureMock.mockResolvedValue({ sessionId: 'sess_1', assetId: 'asset_1' });
    gatherContextMock.mockResolvedValue({ sessionId: 'sess_1', transcript: 'hello', priors: {} });
    inferMock.mockResolvedValue([
      { intentType: 'supply.declared', confidence: 0.9, metadata: {}, consentTier: 'deliberate' },
    ]);
    resolveConsentGateMock.mockResolvedValue('review');
  }

  it('accepts app token + x-acting-for and runs the pipeline with ownerDid', async () => {
    grantAppWrite({ userDid: USER_DID });
    stubPipeline();

    const res = await capturePost(makeCaptureRequest(USER_DID));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('pending_confirm');

    // Verify ownerDid threaded into infer()
    expect(inferMock).toHaveBeenCalledWith(
      expect.anything(),
      FAKE_VOCAB,
      USER_DID,
    );
  });

  it('falls back to appAuth.userDid when x-acting-for is absent', async () => {
    grantAppWrite({ userDid: USER_DID });
    stubPipeline();

    const res = await capturePost(makeCaptureRequest(null));
    expect(res.status).toBe(200);
    expect(inferMock).toHaveBeenCalledWith(expect.anything(), FAKE_VOCAB, USER_DID);
  });

  it('returns 400 when app token has no userDid and x-acting-for is absent', async () => {
    requireAppAuthMock.mockResolvedValue({
      appAuth: { appDid: APP_DID, userDid: undefined, scopes: ['inference:write'] },
    });

    const res = await capturePost(makeCaptureRequest(null));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('X-Acting-For');
  });

  it('falls through to session auth when app token is absent', async () => {
    denyAppAuth();
    grantSessionAuth();
    stubPipeline();

    const res = await capturePost(makeCaptureRequest(null));
    expect(res.status).toBe(200);
    expect(requireAuthMock).toHaveBeenCalledOnce();
    // Session user threaded into infer()
    expect(inferMock).toHaveBeenCalledWith(expect.anything(), FAKE_VOCAB, SESSION_USER);
  });

  it('returns 401 when neither app-auth nor session-auth succeed', async () => {
    denyAppAuth();
    denySessionAuth();

    const res = await capturePost(makeCaptureRequest(null));
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/inference/confirm/[sessionId]
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/inference/confirm/[sessionId] — app-auth path (#1431)', () => {
  const SESSION_ID = 'sess_deliberate_1';
  const params = { params: { sessionId: SESSION_ID } };

  function stubConfirmPipeline() {
    confirmIntentMock.mockResolvedValue(undefined);
    dbLimitMock.mockResolvedValue([{ id: SESSION_ID, vocabularyName: 'imajin' }]);
    getVocabularyMock.mockReturnValue(FAKE_VOCAB);
    resolveIntentMock.mockResolvedValue({
      attestationId: 'att_1',
      intentType: 'supply.declared',
      primitiveType: 'supply',
      externalId: null,
      resolvedAt: new Date().toISOString(),
    });
  }

  it('accepts app token + x-acting-for and confirms the session', async () => {
    grantAppWrite({ userDid: USER_DID });
    stubConfirmPipeline();

    const res = await confirmPost(makeRequest({ actingFor: USER_DID }), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('resolved');
    expect(body.attestationId).toBe('att_1');
    expect(confirmIntentMock).toHaveBeenCalledWith(SESSION_ID, USER_DID);
  });

  it('falls back to appAuth.userDid when x-acting-for is absent', async () => {
    grantAppWrite({ userDid: USER_DID });
    stubConfirmPipeline();

    const res = await confirmPost(makeRequest({ actingFor: null }), params);
    expect(res.status).toBe(200);
    expect(confirmIntentMock).toHaveBeenCalledWith(SESSION_ID, USER_DID);
  });

  it('returns 400 when app token has no userDid and x-acting-for is absent', async () => {
    requireAppAuthMock.mockResolvedValue({
      appAuth: { appDid: APP_DID, userDid: undefined, scopes: ['inference:write'] },
    });

    const res = await confirmPost(makeRequest({ actingFor: null }), params);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('X-Acting-For');
  });

  it('falls through to session auth when app token is absent', async () => {
    denyAppAuth();
    grantSessionAuth();
    stubConfirmPipeline();

    const res = await confirmPost(makeRequest(), params);
    expect(res.status).toBe(200);
    expect(requireAuthMock).toHaveBeenCalledOnce();
    expect(confirmIntentMock).toHaveBeenCalledWith(SESSION_ID, SESSION_USER);
  });

  it('returns 401 when neither app-auth nor session-auth succeed', async () => {
    denyAppAuth();
    denySessionAuth();

    const res = await confirmPost(makeRequest(), params);
    expect(res.status).toBe(401);
  });
});
