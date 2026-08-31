/**
 * Tests for GET /auth/api/knock/pending (#1883) — target-side review surface.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { requireAuthMock, listPendingKnocksForTargetMock } = vi.hoisted(() => ({
  requireAuthMock: vi.fn(),
  listPendingKnocksForTargetMock: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({ requireAuth: requireAuthMock }));
vi.mock('@/src/lib/auth/knock', () => ({ listPendingKnocksForTarget: listPendingKnocksForTargetMock }));

import { GET } from '../route';

const TARGET = 'did:imajin:ryan';
const ENDPOINT = 'http://localhost:3000/auth/api/knock/pending';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /auth/api/knock/pending', () => {
  it('propagates an unauthenticated caller', async () => {
    requireAuthMock.mockResolvedValue({ error: 'Not authenticated', status: 401 });

    const res = await GET(new Request(ENDPOINT));

    expect(res.status).toBe(401);
    expect(listPendingKnocksForTargetMock).not.toHaveBeenCalled();
  });

  it('lists pending knocks for the authenticated identity', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: TARGET } });
    listPendingKnocksForTargetMock.mockResolvedValue([{ knockId: 'knock_1' }]);

    const res = await GET(new Request(ENDPOINT));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ knocks: [{ knockId: 'knock_1' }] });
    expect(listPendingKnocksForTargetMock).toHaveBeenCalledWith(TARGET);
  });

  it('sources the target from actingAs when the caller is impersonating a group/business identity', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: 'did:imajin:controller', actingAs: 'did:imajin:business' } });
    listPendingKnocksForTargetMock.mockResolvedValue([]);

    await GET(new Request(ENDPOINT));

    expect(listPendingKnocksForTargetMock).toHaveBeenCalledWith('did:imajin:business');
  });
});
