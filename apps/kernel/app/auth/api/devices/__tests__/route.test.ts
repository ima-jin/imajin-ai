import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  selectResult: [] as unknown[],
}));

vi.mock('@imajin/logger', () => ({
  withLogger:
    (_service: string, handler: (req: unknown, ctx: { log: unknown }) => unknown) =>
    (req: unknown) => handler(req, { log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }),
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

vi.mock('@imajin/config', () => ({ corsHeaders: () => ({}) }));

vi.mock('@/src/lib/auth/middleware', () => ({
  requireAuth: h.requireAuth,
  unauthorizedResponse: () => new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401 }),
}));

const db = vi.hoisted(() => {
  const orderByMock = vi.fn(() => h.selectResult);
  const whereMock = vi.fn(() => ({ orderBy: orderByMock }));
  const fromMock = vi.fn(() => ({ where: whereMock }));
  const selectMock = vi.fn(() => ({ from: fromMock }));
  return { orderByMock, whereMock, fromMock, selectMock };
});

vi.mock('@/src/db', () => ({
  db: { select: db.selectMock },
  devices: { did: 'did', revoked: 'revoked', lastSeenAt: 'lastSeenAt' },
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => args,
  eq: (...args: unknown[]) => args,
  desc: (col: unknown) => col,
}));

import { GET } from '../route';

function makeReq(): NextRequest {
  return { headers: new Headers(), cookies: { get: () => undefined } } as unknown as NextRequest;
}

const OWNER_DID = 'did:imajin:device-owner';

beforeEach(() => {
  vi.clearAllMocks();
  h.selectResult = [];
});

describe('GET /auth/api/devices (#306)', () => {
  it('requires authentication', async () => {
    h.requireAuth.mockResolvedValue(null);

    const res = await GET(makeReq());

    expect(res.status).toBe(401);
    expect(db.selectMock).not.toHaveBeenCalled();
  });

  it('lists only the caller\'s own devices, excluding revoked ones', async () => {
    h.requireAuth.mockResolvedValue({ sub: OWNER_DID });
    const rows = [{ id: 'dev_1', did: OWNER_DID, revoked: false }];
    h.selectResult = rows;

    const res = await GET(makeReq());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.devices).toEqual(rows);
    expect(db.whereMock).toHaveBeenCalledOnce();
  });
});
