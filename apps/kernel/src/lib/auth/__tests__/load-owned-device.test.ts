/**
 * Tests for resolveOwnedDevice / isOwnedDeviceError (#306) — the shared
 * auth + ownership preamble for the per-device routes. Covers the
 * 401/404/403/200 cases once here rather than duplicating them per route.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  foundDevice: undefined as Record<string, unknown> | undefined,
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
  return { selectLimitMock, selectWhereMock, selectFromMock, selectMock };
});

vi.mock('@/src/db', () => ({
  db: { select: db.selectMock },
  devices: { id: 'id', did: 'did' },
}));

vi.mock('drizzle-orm', () => ({ eq: (...args: unknown[]) => args }));

import { resolveOwnedDevice, isOwnedDeviceError } from '../load-owned-device';

function makeReq(): NextRequest {
  return { headers: new Headers(), cookies: { get: () => undefined } } as unknown as NextRequest;
}

const OWNER_DID = 'did:imajin:device-owner';
const OTHER_DID = 'did:imajin:someone-else';

beforeEach(() => {
  vi.clearAllMocks();
  h.foundDevice = undefined;
});

describe('resolveOwnedDevice (#306)', () => {
  it('returns a 401 error response when unauthenticated', async () => {
    h.requireAuth.mockResolvedValue(null);

    const result = await resolveOwnedDevice(makeReq(), 'dev_1', {});

    expect(isOwnedDeviceError(result)).toBe(true);
    if (isOwnedDeviceError(result)) {
      expect(result.errorResponse.status).toBe(401);
    }
  });

  it('returns a 404 error response for an unknown device id', async () => {
    h.requireAuth.mockResolvedValue({ sub: OWNER_DID });
    h.foundDevice = undefined;

    const result = await resolveOwnedDevice(makeReq(), 'dev_missing', {});

    expect(isOwnedDeviceError(result)).toBe(true);
    if (isOwnedDeviceError(result)) {
      expect(result.errorResponse.status).toBe(404);
    }
  });

  it('returns a 403 error response when the device belongs to a different DID', async () => {
    h.requireAuth.mockResolvedValue({ sub: OTHER_DID });
    h.foundDevice = { id: 'dev_1', did: OWNER_DID };

    const result = await resolveOwnedDevice(makeReq(), 'dev_1', {});

    expect(isOwnedDeviceError(result)).toBe(true);
    if (isOwnedDeviceError(result)) {
      expect(result.errorResponse.status).toBe(403);
    }
  });

  it('resolves the session and device when owned by the caller', async () => {
    h.requireAuth.mockResolvedValue({ sub: OWNER_DID });
    h.foundDevice = { id: 'dev_1', did: OWNER_DID };

    const result = await resolveOwnedDevice(makeReq(), 'dev_1', {});

    expect(isOwnedDeviceError(result)).toBe(false);
    if (!isOwnedDeviceError(result)) {
      expect(result.session.sub).toBe(OWNER_DID);
      expect(result.device).toEqual({ id: 'dev_1', did: OWNER_DID });
    }
  });
});
