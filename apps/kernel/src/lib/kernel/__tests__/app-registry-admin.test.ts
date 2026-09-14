/**
 * Tests for apps/kernel/src/lib/kernel/app-registry-admin.ts (#1990).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  },
}));

const mocks = vi.hoisted(() => {
  const limitMock = vi.fn();
  const whereMock = vi.fn(() => ({ limit: limitMock }));
  const fromMock = vi.fn(() => ({ where: whereMock }));
  const selectMock = vi.fn(() => ({ from: fromMock }));
  const requireAdminMock = vi.fn();
  return { limitMock, whereMock, fromMock, selectMock, requireAdminMock };
});

vi.mock('@/src/db', () => ({
  db: { select: mocks.selectMock },
  registryApps: { id: 'registryApps.id', appDid: 'registryApps.appDid', status: 'registryApps.status' },
}));

vi.mock('drizzle-orm', () => ({ eq: (...args: unknown[]) => ({ eq: args }) }));
vi.mock('@imajin/auth', () => ({ requireAdmin: mocks.requireAdminMock }));

import { requireAdminSession, findRegistryApp } from '../app-registry-admin';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('requireAdminSession (#1990)', () => {
  it('returns an error response when there is no session', async () => {
    mocks.requireAdminMock.mockResolvedValue(null);

    const result = await requireAdminSession();

    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error.status).toBe(401);
  });

  it('returns an error response when the session lacks actingAs', async () => {
    mocks.requireAdminMock.mockResolvedValue({});

    const result = await requireAdminSession();

    expect('error' in result).toBe(true);
  });

  it('returns the session for an admin caller', async () => {
    mocks.requireAdminMock.mockResolvedValue({ actingAs: 'did:imajin:node' });

    const result = await requireAdminSession();

    expect(result).toEqual({ session: { actingAs: 'did:imajin:node' } });
  });
});

describe('findRegistryApp (#1990)', () => {
  it('returns the row when found', async () => {
    mocks.limitMock.mockResolvedValue([{ id: 'app_1', appDid: 'did:imajin:app-1', status: 'active' }]);

    const result = await findRegistryApp('app_1');

    expect(result).toEqual({ id: 'app_1', appDid: 'did:imajin:app-1', status: 'active' });
  });

  it('returns null when no row matches', async () => {
    mocks.limitMock.mockResolvedValue([]);

    expect(await findRegistryApp('app_missing')).toBeNull();
  });
});
