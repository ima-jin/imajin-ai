import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

// 401/404/403 auth+ownership behavior is covered once in
// src/lib/auth/__tests__/load-owned-device.test.ts — this route now just
// delegates to that helper, so it only needs to verify the error response
// passes through unchanged, plus its own success-path DB update.
const h = vi.hoisted(() => ({ resolveOwnedDevice: vi.fn() }));

vi.mock('@imajin/logger', () => ({ createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }) }));
vi.mock('@imajin/config', () => ({ corsHeaders: () => ({}) }));

vi.mock('@/src/lib/auth/load-owned-device', () => ({
  resolveOwnedDevice: h.resolveOwnedDevice,
  isOwnedDeviceError: (result: unknown) => !!result && typeof result === 'object' && 'errorResponse' in result,
}));

const db = vi.hoisted(() => {
  const updateReturningMock = vi.fn();
  const updateWhereMock = vi.fn(() => ({ returning: updateReturningMock }));
  const updateSetMock = vi.fn(() => ({ where: updateWhereMock }));
  const updateMock = vi.fn(() => ({ set: updateSetMock }));
  return { updateReturningMock, updateWhereMock, updateSetMock, updateMock };
});

vi.mock('@/src/db', () => ({ db: { update: db.updateMock }, devices: { id: 'id' } }));
vi.mock('drizzle-orm', () => ({ eq: (...args: unknown[]) => args }));

import { POST } from '../route';

function makeReq(): NextRequest {
  return { headers: new Headers(), cookies: { get: () => undefined } } as unknown as NextRequest;
}

function makeProps(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /auth/api/devices/[id]/trust (#306)', () => {
  it('returns the ownership-check error response unchanged', async () => {
    const errorResponse = new Response(JSON.stringify({ error: 'nope' }), { status: 403 });
    h.resolveOwnedDevice.mockResolvedValue({ errorResponse });

    const res = await POST(makeReq(), makeProps('dev_1'));

    expect(res).toBe(errorResponse);
    expect(db.updateMock).not.toHaveBeenCalled();
  });

  it('marks the device trusted for its own DID', async () => {
    h.resolveOwnedDevice.mockResolvedValue({ session: { sub: 'did:imajin:device-owner' }, device: { id: 'dev_1' } });
    db.updateReturningMock.mockReturnValue([{ id: 'dev_1', trusted: true }]);

    const res = await POST(makeReq(), makeProps('dev_1'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.device.trusted).toBe(true);
    expect(db.updateSetMock).toHaveBeenCalledWith({ trusted: true });
  });
});
