/**
 * Tests for POST /notify/api/internal/backlog (#2044).
 *
 * The actual backlog query + atomic claim lives in and is thoroughly tested
 * by `@/src/lib/notify/backlog` (`backlog.test.ts`). This route is a thin,
 * internal-key-guarded HTTP wrapper `ws-server.js` calls on reconnect, so
 * these tests focus on the route's own responsibilities: caller
 * authentication, request validation, and translating the lookup's
 * result/failure into the wire response.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { getNotificationBacklogMock, logMock } = vi.hoisted(() => ({
  getNotificationBacklogMock: vi.fn(),
  logMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/src/lib/notify/backlog', () => ({
  getNotificationBacklog: getNotificationBacklogMock,
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => logMock,
}));

import { POST } from '../route';

const INTERNAL_KEY = 'test-internal-key';
const DID = 'did:imajin:veteze';
const ENDPOINT = 'http://localhost:3000/notify/api/internal/backlog';

type RouteRequest = Parameters<typeof POST>[0];

function makeRequest(
  body: string,
  { key = INTERNAL_KEY as string | null } = {},
): RouteRequest {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (key !== null) headers.set('x-internal-key', key);
  return new Request(ENDPOINT, { method: 'POST', headers, body }) as unknown as RouteRequest;
}

function fetchBacklog(body: unknown, options?: { key?: string | null }) {
  return POST(makeRequest(JSON.stringify(body), options));
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AUTH_INTERNAL_API_KEY = INTERNAL_KEY;
  getNotificationBacklogMock.mockResolvedValue({ frames: [], truncated: false });
});

afterEach(() => {
  delete process.env.AUTH_INTERNAL_API_KEY;
});

describe('POST /notify/api/internal/backlog — caller authentication', () => {
  it('rejects a request with no x-internal-key header', async () => {
    const res = await fetchBacklog({ did: DID }, { key: null });

    expect(res.status).toBe(401);
    expect(getNotificationBacklogMock).not.toHaveBeenCalled();
  });

  it('rejects a request with the wrong key', async () => {
    const res = await fetchBacklog({ did: DID }, { key: 'nope' });

    expect(res.status).toBe(401);
    expect(getNotificationBacklogMock).not.toHaveBeenCalled();
  });

  it('rejects every caller when AUTH_INTERNAL_API_KEY is unset', async () => {
    delete process.env.AUTH_INTERNAL_API_KEY;

    const res = await fetchBacklog({ did: DID }, { key: null });

    expect(res.status).toBe(401);
    expect(getNotificationBacklogMock).not.toHaveBeenCalled();
  });
});

describe('POST /notify/api/internal/backlog — request body', () => {
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
    const res = await fetchBacklog(body);

    expect(res.status).toBe(400);
    expect(getNotificationBacklogMock).not.toHaveBeenCalled();
  });
});

describe('POST /notify/api/internal/backlog — delegates to getNotificationBacklog', () => {
  it('returns the frames and truncated flag verbatim', async () => {
    const frames = [{ type: 'notification', id: 'ntf_1' }];
    getNotificationBacklogMock.mockResolvedValue({ frames, truncated: false });

    const res = await fetchBacklog({ did: DID });

    expect(getNotificationBacklogMock).toHaveBeenCalledWith(DID);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ frames, truncated: false });
  });

  it('logs a warning when the backlog was truncated', async () => {
    getNotificationBacklogMock.mockResolvedValue({ frames: [{ id: 'ntf_1' }], truncated: true });

    const res = await fetchBacklog({ did: DID });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ truncated: true });
    expect(logMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ did: DID }),
      expect.stringContaining('truncated'),
    );
  });

  it('degrades to an empty, non-truncated backlog rather than throwing when the lookup fails', async () => {
    getNotificationBacklogMock.mockRejectedValue(new Error('connection terminated'));

    const res = await fetchBacklog({ did: DID });

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ frames: [], truncated: false });
    expect(logMock.error).toHaveBeenCalled();
  });
});
