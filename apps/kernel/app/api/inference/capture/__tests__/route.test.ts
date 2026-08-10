import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const {
  mockRequireAppAuth,
  mockRequireAuth,
  mockRateLimit,
  mockInferMime,
  mockIsAllowedMime,
  mockCaptureGesture,
  mockGatherContext,
  mockInfer,
  mockResolveConsentGate,
  mockResolveIntent,
  mockGetVocabulary,
} = vi.hoisted(() => ({
  mockRequireAppAuth: vi.fn(),
  mockRequireAuth: vi.fn(),
  mockRateLimit: vi.fn(),
  mockInferMime: vi.fn(),
  mockIsAllowedMime: vi.fn(),
  mockCaptureGesture: vi.fn(),
  mockGatherContext: vi.fn(),
  mockInfer: vi.fn(),
  mockResolveConsentGate: vi.fn(),
  mockResolveIntent: vi.fn(),
  mockGetVocabulary: vi.fn(),
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

vi.mock('@imajin/config', () => ({
  rateLimit: mockRateLimit,
  getClientIP: () => '203.0.113.7',
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

vi.mock('@/src/lib/media/create-asset', () => ({
  inferMime: mockInferMime,
  isAllowedMime: mockIsAllowedMime,
}));

vi.mock('@/src/lib/inference/capture', () => ({
  captureGesture: mockCaptureGesture,
}));

vi.mock('@/src/lib/inference/context', () => ({
  gatherContext: mockGatherContext,
}));

vi.mock('@/src/lib/inference/policy', () => ({
  infer: mockInfer,
}));

vi.mock('@/src/lib/inference/consent', () => ({
  resolveConsentGate: mockResolveConsentGate,
}));

vi.mock('@/src/lib/inference/resolve', () => ({
  resolveIntent: mockResolveIntent,
}));

vi.mock('@/src/lib/inference/vocabulary', () => ({
  getVocabulary: mockGetVocabulary,
  listVocabularyNames: () => ['imajin', 'agrifortress'],
}));

// `brain.ts` pulls in `@/src/db` (a real drizzle client) and the Gemini/
// Anthropic connectors purely to build `NoBrainSealedError`'s message. The
// route only needs the error TYPE for `instanceof` matching, so the mock
// re-implements just enough of the shape to avoid dragging in a live DB
// client at test-import time.
vi.mock('@/src/lib/inference/brain', () => {
  class NoBrainSealedError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'NoBrainSealedError';
    }
  }
  return { NoBrainSealedError };
});

// ─── Subject ──────────────────────────────────────────────────────────────────

import { POST, OPTIONS } from '../route';
import { NoBrainSealedError } from '@/src/lib/inference/brain';
import { VaultDelegationError } from '@/src/lib/vault/errors';
import { RetryError } from 'ai';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const OWNER_DID = 'did:imajin:supplier';
const APP_DID = 'did:imajin:agrifortress-app';

const VOCAB = { name: 'agrifortress' };

const TOP_INTENT = {
  intentType: 'supply.received',
  confidence: 0.95,
  metadata: { product: 'maize' },
  consentTier: 'deliberate',
};

type RouteRequest = Parameters<typeof POST>[0];

/** App-auth denial shape returned when no app credentials are present at all. */
const NO_APP_CREDENTIALS = {
  error: 'Authorization Bearer <app-token>, or X-App-DID + X-App-Authorization headers required',
  status: 401,
};

function makeReq(
  opts: {
    headers?: Record<string, string>;
    vocabulary?: string;
    omitFile?: boolean;
    invalidFormData?: boolean;
  } = {},
): RouteRequest {
  const form = new FormData();
  if (!opts.omitFile) {
    form.append('file', new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' }), 'voice.webm');
  }
  if (opts.vocabulary) {
    form.append('vocabulary', opts.vocabulary);
  }

  return {
    headers: new Headers(opts.headers ?? {}),
    formData: async () => {
      if (opts.invalidFormData) throw new Error('not multipart');
      return form;
    },
  } as unknown as RouteRequest;
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
  mockRateLimit.mockReturnValue({ limited: false });
  mockRequireAppAuth.mockResolvedValue(NO_APP_CREDENTIALS);
  mockRequireAuth.mockResolvedValue({ identity: { id: OWNER_DID } });
  mockInferMime.mockReturnValue('audio/webm');
  mockIsAllowedMime.mockReturnValue(true);
  mockGetVocabulary.mockReturnValue(VOCAB);
  mockCaptureGesture.mockResolvedValue({
    sessionId: 'session_abc',
    assetId: 'asset_xyz',
    kind: 'voice',
    ownerDid: OWNER_DID,
  });
  mockGatherContext.mockResolvedValue({
    sessionId: 'session_abc',
    assetId: 'asset_xyz',
    transcript: 'received 50 bags of maize',
    priors: { recentConnectionDids: [], timeOfDay: 'morning', recentActivitySummary: '' },
  });
  mockInfer.mockResolvedValue([TOP_INTENT]);
  mockResolveConsentGate.mockResolvedValue('await_confirm');
  mockResolveIntent.mockResolvedValue({
    attestationId: 'attest_1',
    intentType: 'supply.received',
    primitiveType: 'supply.received',
    resolvedAt: '2026-08-05T12:00:00.000Z',
  });
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/inference/capture — session auth', () => {
  it('resolves the acting owner DID and passes no app DID', async () => {
    const res = await POST(makeReq());

    expect(res.status).toBe(200);
    expect(mockCaptureGesture).toHaveBeenCalledWith(
      expect.objectContaining({ ownerDid: OWNER_DID, vocabularyName: 'imajin' }),
    );
    expect(mockCaptureGesture.mock.calls[0][0]).not.toHaveProperty('appDid');
    expect(mockInfer).toHaveBeenCalledWith(expect.anything(), VOCAB, { ownerDid: OWNER_DID });
  });

  it('honours actingFor delegation when resolving the owner DID', async () => {
    mockRequireAuth.mockResolvedValueOnce({
      identity: { id: 'did:imajin:agent', actingFor: OWNER_DID },
    });

    await POST(makeReq());

    expect(mockInfer).toHaveBeenCalledWith(expect.anything(), VOCAB, { ownerDid: OWNER_DID });
  });

  it('returns 401 when neither app nor session auth succeeds', async () => {
    mockRequireAuth.mockResolvedValueOnce({ error: 'Not authenticated', status: 401 });

    const res = await POST(makeReq());

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Not authenticated' });
    expect(mockCaptureGesture).not.toHaveBeenCalled();
  });
});

describe('POST /api/inference/capture — app-provided credentials (#1624)', () => {
  it('requires the infer:provide app scope', async () => {
    mockRequireAppAuth.mockResolvedValueOnce(appAuth());

    await POST(makeReq());

    expect(mockRequireAppAuth).toHaveBeenCalledWith(expect.anything(), { scope: 'infer:provide' });
  });

  it('captures onBehalfOf the delegating user while carrying the app DID', async () => {
    mockRequireAppAuth.mockResolvedValueOnce(appAuth());

    const res = await POST(makeReq());

    expect(res.status).toBe(200);
    expect(mockCaptureGesture).toHaveBeenCalledWith(
      expect.objectContaining({ ownerDid: OWNER_DID, appDid: APP_DID }),
    );
    expect(mockInfer).toHaveBeenCalledWith(expect.anything(), VOCAB, {
      ownerDid: OWNER_DID,
      appDid: APP_DID,
    });
    // Attribution stays with the supplier, never the app.
    expect(mockGatherContext).toHaveBeenCalledWith('session_abc', 'asset_xyz', OWNER_DID);
    expect(mockRequireAuth).not.toHaveBeenCalled();
  });

  it('falls back to X-Acting-For for service tokens with no delegating user', async () => {
    mockRequireAppAuth.mockResolvedValueOnce(appAuth({ userDid: '', isServiceToken: true }));

    const res = await POST(makeReq({ headers: { 'x-acting-for': OWNER_DID } }));

    expect(res.status).toBe(200);
    expect(mockInfer).toHaveBeenCalledWith(expect.anything(), VOCAB, {
      ownerDid: OWNER_DID,
      appDid: APP_DID,
    });
  });

  it('rejects service tokens that name no owner DID', async () => {
    mockRequireAppAuth.mockResolvedValueOnce(appAuth({ userDid: '', isServiceToken: true }));

    const res = await POST(makeReq());

    expect(res.status).toBe(400);
    expect(mockCaptureGesture).not.toHaveBeenCalled();
  });

  it('surfaces the app scope denial rather than falling back to session auth', async () => {
    mockRequireAppAuth.mockResolvedValueOnce({
      error: "Scope 'infer:provide' was not granted",
      status: 403,
    });
    mockRequireAuth.mockResolvedValueOnce({ error: 'Not authenticated', status: 401 });

    const res = await POST(makeReq());

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Scope 'infer:provide' was not granted" });
    expect(mockCaptureGesture).not.toHaveBeenCalled();
  });

  it('surfaces the app auth error when app headers were supplied but invalid', async () => {
    mockRequireAppAuth.mockResolvedValueOnce({ error: 'Invalid app token', status: 401 });
    mockRequireAuth.mockResolvedValueOnce({ error: 'Not authenticated', status: 401 });

    const res = await POST(makeReq({ headers: { 'x-app-did': APP_DID } }));

    expect(await res.json()).toEqual({ error: 'Invalid app token' });
  });
});

describe('POST /api/inference/capture — pipeline outcomes', () => {
  it('resolves immediately for silent intents', async () => {
    mockResolveConsentGate.mockResolvedValueOnce('proceed');

    const res = await POST(makeReq());

    expect(res.status).toBe(200);
    expect(mockResolveIntent).toHaveBeenCalledWith('session_abc', OWNER_DID, VOCAB);
    expect(await res.json()).toEqual(
      expect.objectContaining({ status: 'resolved', attestationId: 'attest_1' }),
    );
  });

  it('returns pending_confirm with candidates for deliberate intents', async () => {
    const res = await POST(makeReq());

    expect(mockResolveIntent).not.toHaveBeenCalled();
    expect(await res.json()).toEqual(
      expect.objectContaining({ status: 'pending_confirm', candidateIntents: [TOP_INTENT] }),
    );
  });

  it('reports failed when no candidate intents are inferred', async () => {
    mockInfer.mockResolvedValueOnce([]);

    const res = await POST(makeReq());

    expect(await res.json()).toEqual(
      expect.objectContaining({ status: 'failed', error: 'No candidate intents inferred' }),
    );
  });

  it('returns 500 with a pipeline_failed code for an unrecognized crash', async () => {
    mockCaptureGesture.mockRejectedValueOnce(new Error('storage offline'));

    const res = await POST(makeReq());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual(
      expect.objectContaining({ error: 'pipeline_failed', message: 'Inference pipeline failed' }),
    );
  });

  /**
   * #1621 removed the env-key fallback, so "nobody sealed a brain" is now a real
   * runtime outcome rather than an impossible one. #1764 gives it its own
   * status/code instead of folding it into the generic 500, and the response
   * must not carry credential material — the resolver names DIDs and
   * connectors, never keys.
   */
  it('returns 422 with a no_brain code when no DID has sealed a brain', async () => {
    mockInfer.mockRejectedValueOnce(
      new NoBrainSealedError(
        `inference_no_brain: no model credential sealed for ${OWNER_DID} — ` +
        "connect Google Gemini (grant 'gemini:infer', seal a key at /gemini/api/token)",
      ),
    );

    const res = await POST(makeReq());

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body).toEqual(
      expect.objectContaining({ error: 'no_brain', message: expect.stringContaining('connect') }),
    );
    expect(JSON.stringify(body)).not.toMatch(/sk-|AIzaSy/);
  });

  /**
   * #1764: a single request can amplify into multiple upstream 429s via the AI
   * SDK's own retry loop. The route must surface that distinctly from a
   * generic crash so the app can tell the caller to back off and retry later.
   */
  it('returns 429 with a rate_limited code when the upstream model is rate limited', async () => {
    const retryError = new RetryError({
      message: 'Failed after 3 attempts. Last error: Too Many Requests',
      reason: 'maxRetriesExceeded',
      errors: [new Error('Too Many Requests')],
    });
    mockInfer.mockRejectedValueOnce(retryError);

    const res = await POST(makeReq());

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual(
      expect.objectContaining({ error: 'rate_limited', message: expect.stringContaining('rate limit') }),
    );
  });

  /**
   * #1764: a sealed key still awaiting the owner's Tier 1 delegation approval
   * is a temporary, actionable state — not a crash.
   */
  it('returns 503 with a credential_pending code when the credential grant is pending', async () => {
    mockInfer.mockRejectedValueOnce(
      new VaultDelegationError('No active delegation grant', {
        field: 'gemini-api-key:did:imajin:supplier',
        nodeDid: OWNER_DID,
      }),
    );

    const res = await POST(makeReq());

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual(
      expect.objectContaining({ error: 'credential_pending' }),
    );
  });
});

describe('POST /api/inference/capture — request validation', () => {
  it('returns 429 when rate limited', async () => {
    mockRateLimit.mockReturnValueOnce({ limited: true, retryAfter: 30 });

    const res = await POST(makeReq());

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('30');
    expect(mockRequireAppAuth).not.toHaveBeenCalled();
  });

  it('returns 400 on invalid multipart data', async () => {
    const res = await POST(makeReq({ invalidFormData: true }));
    expect(res.status).toBe(400);
  });

  it('returns 400 when the file field is missing', async () => {
    const res = await POST(makeReq({ omitFile: true }));
    expect(res.status).toBe(400);
  });

  it('returns 400 for an unknown vocabulary', async () => {
    mockGetVocabulary.mockReturnValueOnce(undefined);

    const res = await POST(makeReq({ vocabulary: 'nope' }));

    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('agrifortress');
  });

  it('returns 415 for a disallowed MIME type', async () => {
    mockIsAllowedMime.mockReturnValueOnce(false);

    const res = await POST(makeReq());

    expect(res.status).toBe(415);
  });

  it('answers CORS pre-flight', async () => {
    const res = await OPTIONS(makeReq());
    expect(res.status).toBe(204);
  });
});
