/**
 * Tests for GET/PUT/DELETE /warp/api/environment (#1632).
 *
 * The environment store is mocked — its vault behaviour is covered in
 * `src/lib/warp/__tests__/environment.test.ts`. What this pins is the route
 * contract: every verb is authenticated, acts on the *acting* DID rather than
 * anything the body claims, validates before writing, and reports the stored
 * value as `null` rather than omitting it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

// Stubbed only so importing the real environment module below does not pull in the
// DB-backed vault (and with it a DATABASE_URL requirement). The store functions
// themselves are replaced wholesale, so these are never reached.
vi.mock('@/src/lib/vault', () => ({
  sealAndStore: vi.fn(),
  loadAndUnseal: vi.fn(),
  deleteFromVault: vi.fn(),
}));

vi.mock('@/src/lib/warp/environment', async () => {
  // The validator is pure and IS the route's 400 contract, so the real one is
  // used — a stubbed validator would let the route accept values dispatch cannot.
  const actual = await vi.importActual<typeof import('@/src/lib/warp/environment')>(
    '@/src/lib/warp/environment',
  );
  return {
    isValidEnvironmentId: actual.isValidEnvironmentId,
    readEnvironmentId: vi.fn(),
    writeEnvironmentId: vi.fn(),
    clearEnvironmentId: vi.fn(),
  };
});

import { GET, PUT, DELETE, OPTIONS } from '../route';
import {
  clearEnvironmentId,
  readEnvironmentId,
  writeEnvironmentId,
} from '@/src/lib/warp/environment';

const OWNER_DID = 'did:imajin:veteze';
const ENV_ID = 'L2DO7swtN7Ku3G7gVPwziI';

type RouteRequest = Parameters<typeof PUT>[0];

function makeReq(body?: unknown, opts: { malformed?: boolean } = {}): RouteRequest {
  return {
    headers: new Headers(),
    json: async () => {
      if (opts.malformed === true) throw new Error('invalid json');
      return body;
    },
  } as unknown as RouteRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAuth.mockResolvedValue({ identity: { id: OWNER_DID } });
  vi.mocked(readEnvironmentId).mockResolvedValue(undefined);
  vi.mocked(writeEnvironmentId).mockResolvedValue(undefined);
  vi.mocked(clearEnvironmentId).mockResolvedValue(true);
});

// ── Auth ──────────────────────────────────────────────────────────────────────

describe('every verb is authenticated', () => {
  it.each([
    ['GET', GET],
    ['PUT', PUT],
    ['DELETE', DELETE],
  ])('returns 401 from %s without touching the store', async (_verb, handler) => {
    mockRequireAuth.mockResolvedValueOnce({ error: 'Unauthorized', status: 401 });

    const res = await handler(makeReq({ environmentId: ENV_ID }));

    expect(res.status).toBe(401);
    expect(readEnvironmentId).not.toHaveBeenCalled();
    expect(writeEnvironmentId).not.toHaveBeenCalled();
    expect(clearEnvironmentId).not.toHaveBeenCalled();
  });

  it('answers CORS pre-flight', async () => {
    const res = await OPTIONS(makeReq());
    expect(res.status).toBe(204);
  });
});

// ── GET ───────────────────────────────────────────────────────────────────────

describe('GET', () => {
  it('returns the stored default for the acting DID', async () => {
    vi.mocked(readEnvironmentId).mockResolvedValue(ENV_ID);

    const res = await GET(makeReq());

    expect(await res.json()).toEqual({ environmentId: ENV_ID });
    expect(readEnvironmentId).toHaveBeenCalledWith(OWNER_DID);
  });

  it('reports an unset default as null rather than omitting the key', async () => {
    // The card distinguishes "no default" from "could not read", so the key has
    // to be present either way.
    const res = await GET(makeReq());

    expect(await res.json()).toEqual({ environmentId: null });
  });

  it('carries the CORS headers', async () => {
    const res = await GET(makeReq());
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://app.imajin.ai');
  });
});

// ── PUT ───────────────────────────────────────────────────────────────────────

describe('PUT', () => {
  it('stores the value against the acting DID, not one named in the body', async () => {
    const res = await PUT(
      makeReq({ environmentId: ENV_ID, did: 'did:imajin:someone-else' }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ environmentId: ENV_ID });
    expect(writeEnvironmentId).toHaveBeenCalledWith(OWNER_DID, ENV_ID);
  });

  it('trims before storing', async () => {
    await PUT(makeReq({ environmentId: `  ${ENV_ID}  ` }));

    expect(writeEnvironmentId).toHaveBeenCalledWith(OWNER_DID, ENV_ID);
  });

  it('returns 400 on malformed JSON', async () => {
    const res = await PUT(makeReq(undefined, { malformed: true }));

    expect(res.status).toBe(400);
    expect(writeEnvironmentId).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', {}],
    ['blank', { environmentId: '   ' }],
    ['non-string', { environmentId: 42 }],
    ['containing a space', { environmentId: 'two words' }],
    ['containing a slash', { environmentId: 'a/b' }],
  ])('returns 400 when environmentId is %s', async (_label, body) => {
    const res = await PUT(makeReq(body));

    expect(res.status).toBe(400);
    expect(writeEnvironmentId).not.toHaveBeenCalled();
  });

  it('returns 500 when the store fails', async () => {
    vi.mocked(writeEnvironmentId).mockRejectedValueOnce(new Error('vault down'));

    const res = await PUT(makeReq({ environmentId: ENV_ID }));

    expect(res.status).toBe(500);
  });
});

// ── DELETE ────────────────────────────────────────────────────────────────────

describe('DELETE', () => {
  it('clears the default for the acting DID', async () => {
    const res = await DELETE(makeReq());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cleared: true, environmentId: null });
    expect(clearEnvironmentId).toHaveBeenCalledWith(OWNER_DID);
  });

  it('succeeds when there was no default to clear', async () => {
    vi.mocked(clearEnvironmentId).mockResolvedValue(false);

    const res = await DELETE(makeReq());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cleared: false, environmentId: null });
  });

  it('returns 500 when clearing fails', async () => {
    vi.mocked(clearEnvironmentId).mockRejectedValueOnce(new Error('vault down'));

    const res = await DELETE(makeReq());

    expect(res.status).toBe(500);
  });
});
