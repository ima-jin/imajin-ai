import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  foundDevice: undefined as Record<string, unknown> | undefined,
  updatedDevice: undefined as Record<string, unknown> | undefined,
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

vi.mock('@imajin/config', () => ({
  corsHeaders: () => ({}),
}));

vi.mock('@/src/lib/auth/middleware', () => ({
  requireAuth: h.requireAuth,
  unauthorizedResponse: () => new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401 }),
}));

const db = vi.hoisted(() => {
  const selectLimitMock = vi.fn(() => (h.foundDevice ? [h.foundDevice] : []));
  const selectWhereMock = vi.fn(() => ({ limit: selectLimitMock }));
  const selectFromMock = vi.fn(() => ({ where: selectWhereMock }));
  const selectMock = vi.fn(() => ({ from: selectFromMock }));

  const updateReturningMock = vi.fn(() => (h.updatedDevice ? [h.updatedDevice] : []));
  const updateWhereMock = vi.fn(() => ({ returning: updateReturningMock }));
  const updateSetMock = vi.fn(() => ({ where: updateWhereMock }));
  const updateMock = vi.fn(() => ({ set: updateSetMock }));

  return { selectLimitMock, selectWhereMock, selectFromMock, selectMock, updateReturningMock, updateWhereMock, updateSetMock, updateMock };
});

vi.mock('@/src/db', () => ({
  db: { select: db.selectMock, update: db.updateMock },
  devices: { id: 'id', did: 'did' },
}));

vi.mock('drizzle-orm', () => ({ eq: (...args: unknown[]) => args }));

import { DELETE } from '../route';

function makeReq(): NextRequest {
  return { headers: new Headers(), cookies: { get: () => undefined } } as unknown as NextRequest;
}

function makeProps(id: string) {
  return { params: Promise.resolve({ id }) };
}

const OWNER_DID = 'did:imajin:device-owner';
const OTHER_DID = 'did:imajin:someone-else';

beforeEach(() => {
  vi.clearAllMocks();
  h.foundDevice = undefined;
  h.updatedDevice = undefined;
});

describe('DELETE /auth/api/devices/[id] (#306)', () => {
  it('requires authentication', async () => {
    h.requireAuth.mockResolvedValue(null);

    const res = await DELETE(makeReq(), makeProps('dev_1'));

    expect(res.status).toBe(401);
    expect(db.updateMock).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown device id', async () => {
    h.requireAuth.mockResolvedValue({ sub: OWNER_DID });
    h.foundDevice = undefined;

    const res = await DELETE(makeReq(), makeProps('dev_missing'));

    expect(res.status).toBe(404);
    expect(db.updateMock).not.toHaveBeenCalled();
  });

  it('returns 403 when the device belongs to a different DID', async () => {
    h.requireAuth.mockResolvedValue({ sub: OTHER_DID });
    h.foundDevice = { id: 'dev_1', did: OWNER_DID, revoked: false };

    const res = await DELETE(makeReq(), makeProps('dev_1'));

    expect(res.status).toBe(403);
    expect(db.updateMock).not.toHaveBeenCalled();
  });

  it('revokes (soft-deletes) the device for its own DID and hides it from the list', async () => {
    h.requireAuth.mockResolvedValue({ sub: OWNER_DID });
    h.foundDevice = { id: 'dev_1', did: OWNER_DID, revoked: false };
    h.updatedDevice = { id: 'dev_1', did: OWNER_DID, revoked: true };

    const res = await DELETE(makeReq(), makeProps('dev_1'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.revoked).toBe(true);
    expect(body.device.revoked).toBe(true);
    expect(db.updateSetMock).toHaveBeenCalledWith({ revoked: true });
  });
});
