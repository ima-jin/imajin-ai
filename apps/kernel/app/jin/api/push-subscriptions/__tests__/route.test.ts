/**
 * Tests for GET/POST/DELETE /jin/api/push-subscriptions (#2291).
 *
 * Mirrors the vault-proposals route test conventions: real
 * `isOperatorIdentity` (only `getOperatorDid` is mocked) so the operator
 * gate is exercised for real, not stood in for.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  OPERATOR_DID,
  operatorIdentity,
  otherHumanIdentity,
  agentActingForOperatorIdentity,
} from '@/src/lib/notify/__tests__/operator-approvals-test-helpers';

const {
  mockRequireAuth,
  mockGetOperatorDid,
  mockGetVapidPublicKey,
  mockInsertValues,
  mockOnConflictDoUpdate,
  mockUpdateWhere,
} = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockGetOperatorDid: vi.fn(),
  mockGetVapidPublicKey: vi.fn(),
  mockInsertValues: vi.fn(),
  mockOnConflictDoUpdate: vi.fn(),
  mockUpdateWhere: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: mockRequireAuth,
}));

vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => new Headers(),
  corsOptions: () => new Response(null, { status: 204 }),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

vi.mock('@/src/lib/kernel/id', () => ({
  generateId: (prefix: string) => `${prefix}_fixedid`,
}));

vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeSelfInfo: vi.fn() }));

vi.mock('@/src/lib/notify/operator-approvals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/src/lib/notify/operator-approvals')>();
  return { ...actual, getOperatorDid: mockGetOperatorDid };
});

vi.mock('@/src/lib/notify/vapid', () => ({
  getVapidPublicKey: mockGetVapidPublicKey,
}));

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return { ...actual, eq: (...args: unknown[]) => ({ eq: args }) };
});

vi.mock('@/src/db', () => ({
  db: {
    insert: vi.fn(() => ({
      values: (...args: unknown[]) => {
        mockInsertValues(...args);
        return { onConflictDoUpdate: mockOnConflictDoUpdate };
      },
    })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: mockUpdateWhere })) })),
  },
  pushSubscriptions: { endpoint: 'endpoint' },
}));

import { GET, POST, DELETE, OPTIONS } from '../route';

function makeReq(method: string, body?: unknown, headers?: Record<string, string>): Request {
  return new Request('https://test.imajin.ai/jin/api/push-subscriptions', {
    method,
    headers,
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
}

const SUBSCRIBE_BODY = { endpoint: 'https://push.example.com/abc', keys: { p256dh: 'p256dh-key', auth: 'auth-key' } };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetOperatorDid.mockResolvedValue(OPERATOR_DID);
  mockRequireAuth.mockResolvedValue({ identity: operatorIdentity() });
  mockGetVapidPublicKey.mockResolvedValue('pub-key');
  mockOnConflictDoUpdate.mockResolvedValue(undefined);
  mockUpdateWhere.mockResolvedValue(undefined);
});

describe('OPTIONS /jin/api/push-subscriptions', () => {
  it('delegates to the shared CORS preflight handler', async () => {
    const res = await OPTIONS(makeReq('OPTIONS') as Parameters<typeof OPTIONS>[0]);
    expect(res.status).toBe(204);
  });
});

describe('GET /jin/api/push-subscriptions', () => {
  it('returns 401 when unauthenticated', async () => {
    mockRequireAuth.mockResolvedValueOnce({ error: 'Unauthorized', status: 401 });

    const res = await GET(makeReq('GET') as Parameters<typeof GET>[0]);

    expect(res.status).toBe(401);
  });

  it('reports isOperator: false with no key material for a non-operator (never a 403)', async () => {
    mockRequireAuth.mockResolvedValueOnce({ identity: otherHumanIdentity() });

    const res = await GET(makeReq('GET') as Parameters<typeof GET>[0]);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { isOperator: boolean; publicKey?: string };
    expect(body).toEqual({ isOperator: false });
    expect(mockGetVapidPublicKey).not.toHaveBeenCalled();
  });

  it('returns the VAPID public key for the operator', async () => {
    const res = await GET(makeReq('GET') as Parameters<typeof GET>[0]);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { isOperator: boolean; publicKey: string | null };
    expect(body).toEqual({ isOperator: true, publicKey: 'pub-key' });
  });

  it('returns a null publicKey when VAPID keys are not yet provisioned', async () => {
    mockGetVapidPublicKey.mockResolvedValueOnce(null);

    const res = await GET(makeReq('GET') as Parameters<typeof GET>[0]);

    const body = (await res.json()) as { publicKey: string | null };
    expect(body.publicKey).toBeNull();
  });
});

describe('POST /jin/api/push-subscriptions — auth', () => {
  it('returns 401 when unauthenticated', async () => {
    mockRequireAuth.mockResolvedValueOnce({ error: 'Unauthorized', status: 401 });

    const res = await POST(makeReq('POST', SUBSCRIBE_BODY) as Parameters<typeof POST>[0]);

    expect(res.status).toBe(401);
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it('rejects a non-operator human with 403', async () => {
    mockRequireAuth.mockResolvedValueOnce({ identity: otherHumanIdentity() });

    const res = await POST(makeReq('POST', SUBSCRIBE_BODY) as Parameters<typeof POST>[0]);

    expect(res.status).toBe(403);
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it('rejects an agent acting for the operator via X-Acting-For with 403', async () => {
    mockRequireAuth.mockResolvedValueOnce({ identity: agentActingForOperatorIdentity() });

    const res = await POST(makeReq('POST', SUBSCRIBE_BODY) as Parameters<typeof POST>[0]);

    expect(res.status).toBe(403);
  });
});

describe('POST /jin/api/push-subscriptions — validation', () => {
  it('returns 400 for malformed JSON', async () => {
    const res = await POST(makeReq('POST', 'not json') as Parameters<typeof POST>[0]);
    expect(res.status).toBe(400);
  });

  it('returns 400 when endpoint is missing', async () => {
    const res = await POST(makeReq('POST', { keys: { p256dh: 'a', auth: 'b' } }) as Parameters<typeof POST>[0]);
    expect(res.status).toBe(400);
  });

  it('returns 400 when keys are missing', async () => {
    const res = await POST(makeReq('POST', { endpoint: 'https://push.example.com/abc' }) as Parameters<typeof POST>[0]);
    expect(res.status).toBe(400);
  });

  it('returns 400 when keys.auth is missing', async () => {
    const res = await POST(makeReq('POST', { endpoint: 'https://push.example.com/abc', keys: { p256dh: 'a' } }) as Parameters<typeof POST>[0]);
    expect(res.status).toBe(400);
  });
});

describe('POST /jin/api/push-subscriptions — success', () => {
  it('upserts the subscription for the operator and returns 201', async () => {
    const res = await POST(makeReq('POST', SUBSCRIBE_BODY, { 'user-agent': 'TestBrowser/1.0' }) as Parameters<typeof POST>[0]);

    expect(res.status).toBe(201);
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        operatorDid: OPERATOR_DID,
        endpoint: SUBSCRIBE_BODY.endpoint,
        p256dh: 'p256dh-key',
        auth: 'auth-key',
        userAgent: 'TestBrowser/1.0',
        revokedAt: null,
      }),
    );
    expect(mockOnConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.anything(),
        set: expect.objectContaining({ operatorDid: OPERATOR_DID, p256dh: 'p256dh-key', auth: 'auth-key', revokedAt: null }),
      }),
    );
  });

  it('returns 500 without leaking failure detail when the upsert throws', async () => {
    mockOnConflictDoUpdate.mockRejectedValueOnce(new Error('db unavailable'));

    const res = await POST(makeReq('POST', SUBSCRIBE_BODY) as Parameters<typeof POST>[0]);

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).not.toContain('db unavailable');
  });
});

describe('DELETE /jin/api/push-subscriptions', () => {
  it('returns 401 when unauthenticated', async () => {
    mockRequireAuth.mockResolvedValueOnce({ error: 'Unauthorized', status: 401 });

    const res = await DELETE(makeReq('DELETE', { endpoint: SUBSCRIBE_BODY.endpoint }) as Parameters<typeof DELETE>[0]);

    expect(res.status).toBe(401);
  });

  it('rejects a non-operator human with 403', async () => {
    mockRequireAuth.mockResolvedValueOnce({ identity: otherHumanIdentity() });

    const res = await DELETE(makeReq('DELETE', { endpoint: SUBSCRIBE_BODY.endpoint }) as Parameters<typeof DELETE>[0]);

    expect(res.status).toBe(403);
    expect(mockUpdateWhere).not.toHaveBeenCalled();
  });

  it('returns 400 when endpoint is missing', async () => {
    const res = await DELETE(makeReq('DELETE', {}) as Parameters<typeof DELETE>[0]);
    expect(res.status).toBe(400);
  });

  it('revokes the subscription and returns ok', async () => {
    const res = await DELETE(makeReq('DELETE', { endpoint: SUBSCRIBE_BODY.endpoint }) as Parameters<typeof DELETE>[0]);

    expect(res.status).toBe(200);
    expect(mockUpdateWhere).toHaveBeenCalledTimes(1);
  });

  it('returns 500 without leaking failure detail when the revoke throws', async () => {
    mockUpdateWhere.mockRejectedValueOnce(new Error('db unavailable'));

    const res = await DELETE(makeReq('DELETE', { endpoint: SUBSCRIBE_BODY.endpoint }) as Parameters<typeof DELETE>[0]);

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).not.toContain('db unavailable');
  });
});
