/**
 * Tests for /anthropic/api/token (#1621).
 *
 * Pattern B credential ingestion: the owner pastes their Anthropic key and it is
 * sealed per-DID. The invariants worth pinning are that the key is sealed under
 * the ACTING DID and never travels back out in any response.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockRequireAuth, mockSealApiKey, mockVaultFieldExists } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockSealApiKey: vi.fn(),
  mockVaultFieldExists: vi.fn(),
}));

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

vi.mock('@/src/lib/anthropic/connector', () => ({
  sealApiKey: mockSealApiKey,
  vaultField: (did: string) => `anthropic-api-key:${did}`,
}));

vi.mock('@/src/lib/vault', () => ({ vaultFieldExists: mockVaultFieldExists }));

import { GET, POST, OPTIONS } from '../route';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const OWNER = 'did:imajin:veteze';
const API_KEY = 'sk-ant-SUPER-SECRET-VALUE';

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
  mockSealApiKey.mockResolvedValue(undefined);
  mockVaultFieldExists.mockResolvedValue(false);
});

// ─── GET ─────────────────────────────────────────────────────────────────────

describe('GET /anthropic/api/token', () => {
  it('reports whether a key is sealed for the acting DID', async () => {
    mockVaultFieldExists.mockResolvedValueOnce(true);

    const res = await GET(makeReq());

    expect(await res.json()).toEqual({ keySealed: true });
    expect(mockVaultFieldExists).toHaveBeenCalledWith(`anthropic-api-key:${OWNER}`);
  });

  it('returns 401 without checking the vault when unauthenticated', async () => {
    mockRequireAuth.mockResolvedValueOnce({ error: 'Unauthorized', status: 401 });

    const res = await GET(makeReq());

    expect(res.status).toBe(401);
    expect(mockVaultFieldExists).not.toHaveBeenCalled();
  });

  it('never returns the key itself', async () => {
    mockVaultFieldExists.mockResolvedValueOnce(true);

    const res = await GET(makeReq());

    expect(JSON.stringify(await res.json())).not.toContain(API_KEY);
  });
});

// ─── POST ────────────────────────────────────────────────────────────────────

describe('POST /anthropic/api/token', () => {
  it('seals the key for the acting DID', async () => {
    const res = await POST(makeReq({ token: API_KEY }));

    expect(res.status).toBe(201);
    expect(mockSealApiKey).toHaveBeenCalledWith(OWNER, API_KEY, undefined, undefined);
  });

  it('forwards the optional baseUrl and modelId overrides', async () => {
    await POST(makeReq({
      token: API_KEY,
      baseUrl: 'https://gateway.example/anthropic',
      modelId: 'claude-opus-4-20250514',
    }));

    expect(mockSealApiKey).toHaveBeenCalledWith(
      OWNER,
      API_KEY,
      'https://gateway.example/anthropic',
      'claude-opus-4-20250514',
    );
  });

  it('trims surrounding whitespace from a pasted key', async () => {
    await POST(makeReq({ token: `  ${API_KEY}  ` }));

    expect(mockSealApiKey).toHaveBeenCalledWith(OWNER, API_KEY, undefined, undefined);
  });

  it('treats blank optional overrides as absent', async () => {
    await POST(makeReq({ token: API_KEY, baseUrl: '   ', modelId: '' }));

    expect(mockSealApiKey).toHaveBeenCalledWith(OWNER, API_KEY, undefined, undefined);
  });

  it('never echoes the key back in the success response', async () => {
    const res = await POST(makeReq({ token: API_KEY }));

    expect(JSON.stringify(await res.json())).not.toContain(API_KEY);
  });

  it('returns 401 without sealing when unauthenticated', async () => {
    mockRequireAuth.mockResolvedValueOnce({ error: 'Unauthorized', status: 401 });

    const res = await POST(makeReq({ token: API_KEY }));

    expect(res.status).toBe(401);
    expect(mockSealApiKey).not.toHaveBeenCalled();
  });

  it('returns 400 on malformed JSON', async () => {
    const res = await POST(makeReq(undefined, { invalidJson: true }));

    expect(res.status).toBe(400);
    expect(mockSealApiKey).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', {}],
    ['blank', { token: '   ' }],
    ['non-string', { token: 42 }],
  ])('returns 400 when the token is %s', async (_label, body) => {
    const res = await POST(makeReq(body));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'token must be a non-empty string' });
    expect(mockSealApiKey).not.toHaveBeenCalled();
  });

  it('reports a sealing failure without leaking the key', async () => {
    mockSealApiKey.mockRejectedValueOnce(new Error(`vault write failed for ${API_KEY}`));

    const res = await POST(makeReq({ token: API_KEY }));

    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain(API_KEY);
  });

  it('answers CORS pre-flight', async () => {
    expect((await OPTIONS(makeReq())).status).toBe(204);
  });
});
