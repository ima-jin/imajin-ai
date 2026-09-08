/**
 * Tests for POST /notify/api/internal/ack (#2099).
 *
 * The atomic `delivered_at` guard lives in and is thoroughly tested by
 * `@/src/lib/notify/delivery` (`delivery.test.ts`). This route is a thin,
 * internal-key-guarded HTTP wrapper `ws-server.js` calls when a connected
 * socket sends `{ type: 'notification_ack', id }`, so these tests focus on
 * the route's own responsibilities: caller authentication, request
 * validation, and translating the ack's result/failure into the wire
 * response -- including the no-op-not-a-throw contract for an unknown or
 * already-delivered id.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { ackNotificationDeliveryMock, logMock } = vi.hoisted(() => ({
  ackNotificationDeliveryMock: vi.fn(),
  logMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/src/lib/notify/delivery', () => ({
  ackNotificationDelivery: ackNotificationDeliveryMock,
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => logMock,
}));

import { POST } from '../route';

const INTERNAL_KEY = 'test-internal-key';
const ID = 'ntf_abc123';
const ENDPOINT = 'http://localhost:3000/notify/api/internal/ack';

type RouteRequest = Parameters<typeof POST>[0];

function makeRequest(
  body: string,
  { key = INTERNAL_KEY as string | null } = {},
): RouteRequest {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (key !== null) headers.set('x-internal-key', key);
  return new Request(ENDPOINT, { method: 'POST', headers, body }) as unknown as RouteRequest;
}

function ack(body: unknown, options?: { key?: string | null }) {
  return POST(makeRequest(JSON.stringify(body), options));
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AUTH_INTERNAL_API_KEY = INTERNAL_KEY;
  ackNotificationDeliveryMock.mockResolvedValue(true);
});

afterEach(() => {
  delete process.env.AUTH_INTERNAL_API_KEY;
});

describe('POST /notify/api/internal/ack — caller authentication', () => {
  it('rejects a request with no x-internal-key header', async () => {
    const res = await ack({ id: ID }, { key: null });

    expect(res.status).toBe(401);
    expect(ackNotificationDeliveryMock).not.toHaveBeenCalled();
  });

  it('rejects a request with the wrong key', async () => {
    const res = await ack({ id: ID }, { key: 'nope' });

    expect(res.status).toBe(401);
    expect(ackNotificationDeliveryMock).not.toHaveBeenCalled();
  });

  it('rejects every caller when AUTH_INTERNAL_API_KEY is unset', async () => {
    delete process.env.AUTH_INTERNAL_API_KEY;

    const res = await ack({ id: ID }, { key: null });

    expect(res.status).toBe(401);
    expect(ackNotificationDeliveryMock).not.toHaveBeenCalled();
  });
});

describe('POST /notify/api/internal/ack — request body', () => {
  it('rejects a malformed JSON body', async () => {
    const res = await POST(makeRequest('{ not json'));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid JSON' });
  });

  it.each([
    ['missing id', {}],
    ['empty id', { id: '' }],
    ['non-string id', { id: 42 }],
    ['a null body', null],
  ])('rejects %s with 400', async (_label, body) => {
    const res = await ack(body);

    expect(res.status).toBe(400);
    expect(ackNotificationDeliveryMock).not.toHaveBeenCalled();
  });
});

describe('POST /notify/api/internal/ack — delegates to ackNotificationDelivery', () => {
  it('acks the row and reports delivered: true', async () => {
    ackNotificationDeliveryMock.mockResolvedValue(true);

    const res = await ack({ id: ID });

    expect(ackNotificationDeliveryMock).toHaveBeenCalledWith(ID);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, delivered: true });
  });

  it('is a no-op, not an error, for an unknown or already-delivered id', async () => {
    ackNotificationDeliveryMock.mockResolvedValue(false);

    const res = await ack({ id: ID });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, delivered: false });
  });

  it('degrades to a 500 rather than throwing when the ack itself fails', async () => {
    ackNotificationDeliveryMock.mockRejectedValue(new Error('connection terminated'));

    const res = await ack({ id: ID });

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ ok: false });
    expect(logMock.error).toHaveBeenCalled();
  });
});
