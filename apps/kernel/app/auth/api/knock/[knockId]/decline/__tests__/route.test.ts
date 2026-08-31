/**
 * Tests for POST /auth/api/knock/:knockId/decline (#1883).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { requireAuthMock, declineKnockMock } = vi.hoisted(() => ({
  requireAuthMock: vi.fn(),
  declineKnockMock: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({ requireAuth: requireAuthMock }));
vi.mock('@/src/lib/auth/knock', () => ({ declineKnock: declineKnockMock }));

import { POST } from '../route';

const TARGET = 'did:imajin:ryan';
const KNOCK_ID = 'knock_1';
const ENDPOINT = `http://localhost:3000/auth/api/knock/${KNOCK_ID}/decline`;

function makeRequest(): Parameters<typeof POST>[0] {
  return new Request(ENDPOINT, { method: 'POST' });
}

function params() {
  return { params: Promise.resolve({ knockId: KNOCK_ID }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /auth/api/knock/:knockId/decline', () => {
  it('propagates an unauthenticated caller', async () => {
    requireAuthMock.mockResolvedValue({ error: 'Not authenticated', status: 401 });

    const res = await POST(makeRequest(), params());

    expect(res.status).toBe(401);
    expect(declineKnockMock).not.toHaveBeenCalled();
  });

  it('declines using the directly authenticated identity as requestedBy', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: TARGET } });
    declineKnockMock.mockResolvedValue({ declined: true });

    const res = await POST(makeRequest(), params());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ declined: true });
    expect(declineKnockMock).toHaveBeenCalledWith({ knockId: KNOCK_ID, requestedBy: TARGET });
  });

  it('surfaces a lib-level error with its own status', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: TARGET } });
    declineKnockMock.mockResolvedValue({ error: 'Knock not found', status: 404 });

    const res = await POST(makeRequest(), params());

    expect(res.status).toBe(404);
  });
});
