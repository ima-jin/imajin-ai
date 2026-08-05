/**
 * Tests for the shared token-paste credential route factory (#1621).
 *
 * Every token-paste connector (Gemini, Anthropic, and the next one) gets its
 * credential handlers from here, so this is where the behaviour is pinned: the
 * key is sealed under the ACTING DID, and it never travels back out — not in a
 * success body, not in an error body.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockRequireAuth } = vi.hoisted(() => ({ mockRequireAuth: vi.fn() }));

vi.mock('@imajin/auth', () => ({
  requireAuth: mockRequireAuth,
  resolveActingDid: (identity: { id: string }) => identity.id,
}));

vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({ 'Access-Control-Allow-Origin': 'https://app.imajin.ai' }),
  corsOptions: () => new Response(null, { status: 204 }),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { createConnectorTokenRoutes } from '../connector-token-route';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const OWNER = 'did:imajin:veteze';
const API_KEY = 'sk-provider-SUPER-SECRET-VALUE';

const sealApiKey = vi.fn();
const keySealed = vi.fn();

const { GET, POST, OPTIONS } = createConnectorTokenRoutes({
  name: 'TestProvider',
  sealApiKey,
  keySealed,
});

type RouteRequest = Parameters<typeof POST>[0];

function makeReq(body?: unknown, opts: { invalidJson?: boolean } = {}): RouteRequest {
  return {
    headers: new Headers(),
    json: async () => {
      if (opts.invalidJson) throw new Error('invalid json');
      return body;
    },
  } as unknown as RouteRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAuth.mockResolvedValue({ identity: { id: OWNER } });
  sealApiKey.mockResolvedValue(undefined);
  keySealed.mockResolvedValue(false);
});

// ─── GET ─────────────────────────────────────────────────────────────────────

describe('token route — GET', () => {
  it('reports whether a key is sealed for the acting DID', async () => {
    keySealed.mockResolvedValueOnce(true);

    const res = await GET(makeReq());

    expect(await res.json()).toEqual({ keySealed: true });
    expect(keySealed).toHaveBeenCalledWith(OWNER);
  });

  it('returns 401 without probing the vault when unauthenticated', async () => {
    mockRequireAuth.mockResolvedValueOnce({ error: 'Unauthorized', status: 401 });

    const res = await GET(makeReq());

    expect(res.status).toBe(401);
    expect(keySealed).not.toHaveBeenCalled();
  });

  it('carries CORS headers', async () => {
    const res = await GET(makeReq());
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://app.imajin.ai');
  });
});

// ─── POST ────────────────────────────────────────────────────────────────────

describe('token route — POST', () => {
  it('seals the key for the acting DID', async () => {
    const res = await POST(makeReq({ token: API_KEY }));

    expect(res.status).toBe(201);
    expect(sealApiKey).toHaveBeenCalledWith(OWNER, API_KEY, undefined, undefined);
  });

  it('forwards the optional baseUrl and modelId overrides', async () => {
    await POST(makeReq({
      token: API_KEY,
      baseUrl: 'https://gateway.example/v1',
      modelId: 'some-model-id',
    }));

    expect(sealApiKey).toHaveBeenCalledWith(
      OWNER,
      API_KEY,
      'https://gateway.example/v1',
      'some-model-id',
    );
  });

  it('trims a pasted key', async () => {
    await POST(makeReq({ token: `  ${API_KEY}  ` }));

    expect(sealApiKey).toHaveBeenCalledWith(OWNER, API_KEY, undefined, undefined);
  });

  it('treats blank or non-string overrides as absent', async () => {
    await POST(makeReq({ token: API_KEY, baseUrl: '   ', modelId: 42 }));

    expect(sealApiKey).toHaveBeenCalledWith(OWNER, API_KEY, undefined, undefined);
  });

  it('never echoes the key in the success body', async () => {
    const res = await POST(makeReq({ token: API_KEY }));

    expect(JSON.stringify(await res.json())).not.toContain(API_KEY);
  });

  it('returns 401 without sealing when unauthenticated', async () => {
    mockRequireAuth.mockResolvedValueOnce({ error: 'Unauthorized', status: 401 });

    const res = await POST(makeReq({ token: API_KEY }));

    expect(res.status).toBe(401);
    expect(sealApiKey).not.toHaveBeenCalled();
  });

  it('returns 400 on malformed JSON', async () => {
    const res = await POST(makeReq(undefined, { invalidJson: true }));

    expect(res.status).toBe(400);
    expect(sealApiKey).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', {}],
    ['blank', { token: '   ' }],
    ['non-string', { token: 42 }],
  ])('returns 400 when the token is %s', async (_label, body) => {
    const res = await POST(makeReq(body));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'token must be a non-empty string' });
    expect(sealApiKey).not.toHaveBeenCalled();
  });

  /**
   * The route used to return `detail: String(err)`. On a credential path an
   * upstream message can embed the value being sealed, so the response now says
   * only THAT sealing failed and the cause is logged server-side.
   */
  it('reports a sealing failure without leaking the key from the error', async () => {
    sealApiKey.mockRejectedValueOnce(new Error(`vault write failed for ${API_KEY}`));

    const res = await POST(makeReq({ token: API_KEY }));

    expect(res.status).toBe(500);
    const body = JSON.stringify(await res.json());
    expect(body).not.toContain(API_KEY);
    expect(body).toContain('Failed to seal TestProvider API key');
  });

  it('names the connector in the failure so logs and UI stay legible', async () => {
    sealApiKey.mockRejectedValueOnce(new Error('boom'));

    const res = await POST(makeReq({ token: API_KEY }));

    expect(await res.json()).toEqual({ error: 'Failed to seal TestProvider API key' });
  });
});

// ─── OPTIONS ─────────────────────────────────────────────────────────────────

describe('token route — OPTIONS', () => {
  it('answers CORS pre-flight', async () => {
    expect((await OPTIONS(makeReq())).status).toBe(204);
  });
});
