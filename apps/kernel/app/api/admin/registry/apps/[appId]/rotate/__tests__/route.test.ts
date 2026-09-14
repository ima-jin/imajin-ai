/**
 * Tests for apps/kernel/app/api/admin/registry/apps/[appId]/rotate/route.ts (#1990).
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
  const returningMock = vi.fn().mockResolvedValue([{ id: 'app_1', publicKey: 'new-pub-key' }]);
  const setMock = vi.fn(() => ({ where: vi.fn(() => ({ returning: returningMock })) }));
  const updateMock = vi.fn(() => ({ set: setMock }));

  const requireAdminSessionMock = vi.fn();
  const findRegistryAppMock = vi.fn();
  const emitAttestationMock = vi.fn().mockResolvedValue(undefined);
  const generateKeypairMock = vi.fn(() => ({ privateKey: 'new-priv', publicKey: 'new-pub-key' }));
  return { updateMock, setMock, returningMock, requireAdminSessionMock, findRegistryAppMock, emitAttestationMock, generateKeypairMock };
});

vi.mock('@/src/db', () => ({
  db: { update: mocks.updateMock },
  registryApps: { id: 'registryApps.id', appDid: 'registryApps.appDid', status: 'registryApps.status', publicKey: 'registryApps.publicKey' },
}));

vi.mock('drizzle-orm', () => ({ eq: (...args: unknown[]) => ({ eq: args }) }));

vi.mock('@imajin/auth', () => ({
  generateKeypair: mocks.generateKeypairMock,
  emitAttestation: mocks.emitAttestationMock,
}));

vi.mock('@/src/lib/kernel/app-registry-admin', () => ({
  requireAdminSession: mocks.requireAdminSessionMock,
  findRegistryApp: mocks.findRegistryAppMock,
}));

vi.mock('@imajin/logger', () => ({ createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }) }));

import { POST } from '../route';

function makeRequest(): Request {
  return new Request('https://kernel.test/api/admin/registry/apps/app_1/rotate', { method: 'POST' });
}
function props(appId: string) {
  return { params: Promise.resolve({ appId }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdminSessionMock.mockResolvedValue({ session: { actingAs: 'did:imajin:node' } });
  mocks.findRegistryAppMock.mockResolvedValue({ id: 'app_1', appDid: 'did:imajin:app-1', status: 'active' });
});

describe('POST /api/admin/registry/apps/:appId/rotate (#1990)', () => {
  it('propagates the shared admin-session error response for a non-admin caller', async () => {
    const unauthorized = new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    mocks.requireAdminSessionMock.mockResolvedValue({ error: unauthorized });

    const res = await POST(makeRequest() as never, props('app_1'));

    expect(res.status).toBe(401);
    expect(mocks.generateKeypairMock).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown app', async () => {
    mocks.findRegistryAppMock.mockResolvedValue(null);

    const res = await POST(makeRequest() as never, props('app_missing'));

    expect(res.status).toBe(404);
  });

  it('refuses to rotate a revoked app', async () => {
    mocks.findRegistryAppMock.mockResolvedValue({ id: 'app_1', appDid: 'did:imajin:app-1', status: 'revoked' });

    const res = await POST(makeRequest() as never, props('app_1'));

    expect(res.status).toBe(409);
    expect(mocks.generateKeypairMock).not.toHaveBeenCalled();
  });

  it('generates a new keypair, updates publicKey, keeps appDid, and returns the private key once', async () => {
    const res = await POST(makeRequest() as never, props('app_1'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mocks.setMock).toHaveBeenCalledWith(expect.objectContaining({ publicKey: 'new-pub-key' }));
    expect(body.keypair).toEqual({ privateKey: 'new-priv', publicKey: 'new-pub-key' });
    expect(mocks.emitAttestationMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'registry.app.rotated', subject_did: 'did:imajin:app-1' }),
    );
  });
});
