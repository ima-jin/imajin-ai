/**
 * Tests for GET/PUT/DELETE /local/api/settings (#1957).
 *
 * `saveBaseUrl`/`readBaseUrl`/`clearBaseUrl` are mocked here — their own
 * behaviour (egress validation + pinning) is covered in
 * `src/lib/local/__tests__/connector.test.ts`. This pins the route contract:
 * auth on every verb, body validation, and mapping
 * `LocalBaseUrlRejectedError` to 400 with the denial reason.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockResolveOwnerDid = vi.fn();

vi.mock('@/src/lib/kernel/connector-owner-did', () => ({
  resolveConnectorOwnerDid: mockResolveOwnerDid,
}));

vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({ 'Access-Control-Allow-Origin': 'https://app.imajin.ai' }),
  corsOptions: () => new Response(null, { status: 204 }),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

const mockSaveBaseUrl = vi.fn();
const mockReadBaseUrl = vi.fn();
const mockClearBaseUrl = vi.fn();

// A standalone re-implementation of `LocalBaseUrlRejectedError`, NOT
// `vi.importActual`'d from the real module — that module pulls in `@/src/db`
// (DATABASE_URL required) purely to reach this one error class. The route
// only ever checks `instanceof`, so a class with the identical shape here is
// exactly as good a double. `vi.hoisted` so it's available inside the
// hoisted `vi.mock` factory below.
const { LocalBaseUrlRejectedError } = vi.hoisted(() => {
  class LocalBaseUrlRejectedError extends Error {
    reason: string;
    constructor(reason: string, message: string) {
      super(`local_invalid_base_url: ${message}`);
      this.name = 'LocalBaseUrlRejectedError';
      this.reason = reason;
    }
  }
  return { LocalBaseUrlRejectedError };
});

vi.mock('@/src/lib/local/connector', () => ({
  LocalBaseUrlRejectedError,
  saveBaseUrl: mockSaveBaseUrl,
  readBaseUrl: mockReadBaseUrl,
  clearBaseUrl: mockClearBaseUrl,
}));

const { GET, PUT, DELETE, OPTIONS } = await import('../route');

const OWNER_DID = 'did:imajin:owner';

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
  mockResolveOwnerDid.mockResolvedValue({ ok: true, ownerDid: OWNER_DID });
});

describe('every verb is authenticated', () => {
  it.each([
    ['GET', GET],
    ['PUT', PUT],
    ['DELETE', DELETE],
  ])('returns the auth failure from %s without touching the store', async (_verb, handler) => {
    mockResolveOwnerDid.mockResolvedValueOnce({ ok: false, error: 'Unauthorized', status: 401 });

    const res = await handler(makeReq({ baseUrl: 'http://ollama.lan:11434' }));

    expect(res.status).toBe(401);
    expect(mockSaveBaseUrl).not.toHaveBeenCalled();
    expect(mockClearBaseUrl).not.toHaveBeenCalled();
  });

  it('answers CORS pre-flight', async () => {
    expect((await OPTIONS(makeReq())).status).toBe(204);
  });
});

describe('GET', () => {
  it('returns the stored baseUrl for the owner', async () => {
    mockReadBaseUrl.mockResolvedValue({ baseUrl: 'http://ollama.lan:11434', pinnedIp: '192.168.1.50' });

    const res = await GET(makeReq());

    expect(await res.json()).toEqual({ baseUrl: 'http://ollama.lan:11434' });
    expect(mockReadBaseUrl).toHaveBeenCalledWith(OWNER_DID);
  });

  it('reports an unset baseUrl as an empty string', async () => {
    mockReadBaseUrl.mockResolvedValue(undefined);

    expect(await (await GET(makeReq())).json()).toEqual({ baseUrl: '' });
  });
});

describe('PUT', () => {
  it('returns 400 on malformed JSON', async () => {
    const res = await PUT(makeReq(undefined, { malformed: true }));
    expect(res.status).toBe(400);
    expect(mockSaveBaseUrl).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', {}],
    ['blank', { baseUrl: '   ' }],
    ['non-string', { baseUrl: 42 }],
  ])('returns 400 when baseUrl is %s', async (_label, body) => {
    const res = await PUT(makeReq(body));
    expect(res.status).toBe(400);
    expect(mockSaveBaseUrl).not.toHaveBeenCalled();
  });

  it('saves a valid baseUrl', async () => {
    mockSaveBaseUrl.mockResolvedValue({ baseUrl: 'http://ollama.lan:11434', pinnedIp: '192.168.1.50' });

    const res = await PUT(makeReq({ baseUrl: 'http://ollama.lan:11434' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ baseUrl: 'http://ollama.lan:11434' });
    expect(mockSaveBaseUrl).toHaveBeenCalledWith(OWNER_DID, 'http://ollama.lan:11434');
  });

  it('maps a denied URL to 400 with the (safe) denial reason, sealing nothing', async () => {
    mockSaveBaseUrl.mockRejectedValue(new LocalBaseUrlRejectedError('loopback', "'localhost' resolves to 127.0.0.1, which is denied (loopback)"));

    const res = await PUT(makeReq({ baseUrl: 'http://localhost:11434' }));
    const body = await res.json() as { error: string; reason: string };

    expect(res.status).toBe(400);
    expect(body.reason).toBe('loopback');
    expect(body.error).toMatch(/local_invalid_base_url/);
  });

  it('returns 500 on an unexpected save failure', async () => {
    mockSaveBaseUrl.mockRejectedValue(new Error('db down'));

    const res = await PUT(makeReq({ baseUrl: 'http://ollama.lan:11434' }));

    expect(res.status).toBe(500);
  });
});

describe('DELETE', () => {
  it('clears the stored baseUrl', async () => {
    const res = await DELETE(makeReq());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ baseUrl: '' });
    expect(mockClearBaseUrl).toHaveBeenCalledWith(OWNER_DID);
  });

  it('returns 500 when clearing fails', async () => {
    mockClearBaseUrl.mockRejectedValue(new Error('vault down'));

    const res = await DELETE(makeReq());

    expect(res.status).toBe(500);
  });
});
