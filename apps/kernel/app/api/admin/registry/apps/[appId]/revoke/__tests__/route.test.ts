/**
 * Tests for apps/kernel/app/api/admin/registry/apps/[appId]/revoke/route.ts (#1990).
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
  const whereSelectMock = vi.fn(() => ({ limit: limitMock }));
  const fromSelectMock = vi.fn(() => ({ where: whereSelectMock }));
  const selectMock = vi.fn(() => ({ from: fromSelectMock }));

  const updateWhereMock = vi.fn().mockResolvedValue(undefined);
  const setMock = vi.fn(() => ({ where: updateWhereMock }));
  const updateMock = vi.fn(() => ({ set: setMock }));

  const requireAdminMock = vi.fn();
  const emitAttestationMock = vi.fn().mockResolvedValue(undefined);
  return { limitMock, selectMock, updateMock, setMock, updateWhereMock, requireAdminMock, emitAttestationMock };
});

vi.mock('@/src/db', () => ({
  db: { select: mocks.selectMock, update: mocks.updateMock },
  registryApps: { id: 'registryApps.id', appDid: 'registryApps.appDid', status: 'registryApps.status' },
}));

vi.mock('drizzle-orm', () => ({ eq: (...args: unknown[]) => ({ eq: args }) }));

vi.mock('@imajin/auth', () => ({
  requireAdmin: mocks.requireAdminMock,
  emitAttestation: mocks.emitAttestationMock,
}));

vi.mock('@imajin/logger', () => ({ createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }) }));

import { POST } from '../route';

function makeRequest(): Request {
  return new Request('https://kernel.test/api/admin/registry/apps/app_1/revoke', { method: 'POST' });
}
function props(appId: string) {
  return { params: Promise.resolve({ appId }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdminMock.mockResolvedValue({ actingAs: 'did:imajin:node' });
  mocks.limitMock.mockResolvedValue([{ id: 'app_1', appDid: 'did:imajin:app-1', status: 'active' }]);
});

describe('POST /api/admin/registry/apps/:appId/revoke (#1990)', () => {
  it('rejects a non-admin caller with 401', async () => {
    mocks.requireAdminMock.mockResolvedValue(null);

    const res = await POST(makeRequest() as never, props('app_1'));

    expect(res.status).toBe(401);
    expect(mocks.updateMock).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown app', async () => {
    mocks.limitMock.mockResolvedValue([]);

    const res = await POST(makeRequest() as never, props('app_missing'));

    expect(res.status).toBe(404);
  });

  it('revokes an active app and mints a signed registry.app.revoked attestation', async () => {
    const res = await POST(makeRequest() as never, props('app_1'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(mocks.setMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'revoked' }));
    expect(mocks.emitAttestationMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'registry.app.revoked', subject_did: 'did:imajin:app-1', issuer_did: 'did:imajin:node' }),
    );
  });

  it('is idempotent for an already-revoked app (no double attestation)', async () => {
    mocks.limitMock.mockResolvedValue([{ id: 'app_1', appDid: 'did:imajin:app-1', status: 'revoked' }]);

    const res = await POST(makeRequest() as never, props('app_1'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.alreadyRevoked).toBe(true);
    expect(mocks.updateMock).not.toHaveBeenCalled();
    expect(mocks.emitAttestationMock).not.toHaveBeenCalled();
  });
});
