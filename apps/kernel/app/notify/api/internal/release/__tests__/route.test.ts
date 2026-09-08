/**
 * Tests for POST /notify/api/internal/release (#2099).
 *
 * The atomic `ws_sent_at` reset lives in and is thoroughly tested by
 * `@/src/lib/notify/delivery` (`delivery.test.ts`). This route is a thin,
 * internal-key-guarded HTTP wrapper `ws-server.js`'s heartbeat calls the
 * moment it terminates a socket that missed too many pongs, so these tests
 * focus on the route's own responsibilities: caller authentication,
 * request validation, and degrading gracefully on a lookup failure.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { releaseWsClaimsForDidMock, logMock } = vi.hoisted(() => ({
  releaseWsClaimsForDidMock: vi.fn(),
  logMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/src/lib/notify/delivery', () => ({
  releaseWsClaimsForDid: releaseWsClaimsForDidMock,
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => logMock,
}));

import { POST } from '../route';

const INTERNAL_KEY = 'test-internal-key';
const DID = 'did:imajin:veteze';
const ENDPOINT = 'http://localhost:3000/notify/api/internal/release';

type RouteRequest = Parameters<typeof POST>[0];

function makeRequest(
  body: string,
  { key = INTERNAL_KEY as string | null } = {},
): RouteRequest {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (key !== null) headers.set('x-internal-key', key);
  return new Request(ENDPOINT, { method: 'POST', headers, body }) as unknown as RouteRequest;
}

function release(body: unknown, options?: { key?: string | null }) {
  return POST(makeRequest(JSON.stringify(body), options));
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AUTH_INTERNAL_API_KEY = INTERNAL_KEY;
  releaseWsClaimsForDidMock.mockResolvedValue(undefined);
});

afterEach(() => {
  delete process.env.AUTH_INTERNAL_API_KEY;
});

describe('POST /notify/api/internal/release — caller authentication', () => {
  it('rejects a request with no x-internal-key header', async () => {
    const res = await release({ did: DID }, { key: null });

    expect(res.status).toBe(401);
    expect(releaseWsClaimsForDidMock).not.toHaveBeenCalled();
  });

  it('rejects a request with the wrong key', async () => {
    const res = await release({ did: DID }, { key: 'nope' });

    expect(res.status).toBe(401);
    expect(releaseWsClaimsForDidMock).not.toHaveBeenCalled();
  });

  it('rejects every caller when AUTH_INTERNAL_API_KEY is unset', async () => {
    delete process.env.AUTH_INTERNAL_API_KEY;

    const res = await release({ did: DID }, { key: null });

    expect(res.status).toBe(401);
    expect(releaseWsClaimsForDidMock).not.toHaveBeenCalled();
  });
});

describe('POST /notify/api/internal/release — request body', () => {
  it('rejects a malformed JSON body', async () => {
    const res = await POST(makeRequest('{ not json'));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid JSON' });
  });

  it.each([
    ['missing did', {}],
    ['empty did', { did: '' }],
    ['non-string did', { did: 42 }],
    ['a null body', null],
  ])('rejects %s with 400', async (_label, body) => {
    const res = await release(body);

    expect(res.status).toBe(400);
    expect(releaseWsClaimsForDidMock).not.toHaveBeenCalled();
  });
});

describe('POST /notify/api/internal/release — delegates to releaseWsClaimsForDid', () => {
  it('releases the DID\'s claims and reports ok: true', async () => {
    const res = await release({ did: DID });

    expect(releaseWsClaimsForDidMock).toHaveBeenCalledWith(DID);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('degrades to a 500 rather than throwing when the release itself fails', async () => {
    releaseWsClaimsForDidMock.mockRejectedValue(new Error('connection terminated'));

    const res = await release({ did: DID });

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ ok: false });
    expect(logMock.error).toHaveBeenCalled();
  });
});
