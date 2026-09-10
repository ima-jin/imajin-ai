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
  const updateWhereMock = vi.fn().mockResolvedValue(undefined);
  const setMock = vi.fn(() => ({ where: updateWhereMock }));
  const updateMock = vi.fn(() => ({ set: setMock }));

  const requireAdminSessionMock = vi.fn();
  const findRegistryAppMock = vi.fn();
  const emitAttestationMock = vi.fn().mockResolvedValue(undefined);
  return { updateMock, setMock, updateWhereMock, requireAdminSessionMock, findRegistryAppMock, emitAttestationMock };
});

vi.mock('@/src/db', () => ({
  db: { update: mocks.updateMock },
  registryApps: { id: 'registryApps.id', appDid: 'registryApps.appDid', status: 'registryApps.status' },
}));

vi.mock('drizzle-orm', () => ({ eq: (...args: unknown[]) => ({ eq: args }) }));

vi.mock('@imajin/auth', () => ({ emitAttestation: mocks.emitAttestationMock }));

vi.mock('@/src/lib/kernel/app-registry-admin', () => ({
  requireAdminSession: mocks.requireAdminSessionMock,
  findRegistryApp: mocks.findRegistryAppMock,
}));

vi.mock('@imajin/logger', () => ({ createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }) }));

import { POST } from '../route';

const APP_ID = 'app_2';
const OPERATOR_DID = 'did:imajin:operator';
const TARGET_APP_DID = 'did:imajin:app-2';

function revokeRequest(): Request {
  return new Request(`https://kernel.test/api/admin/registry/apps/${APP_ID}/revoke`, { method: 'POST' });
}
function withAppId() {
  return { params: Promise.resolve({ appId: APP_ID }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdminSessionMock.mockResolvedValue({ session: { actingAs: OPERATOR_DID } });
  mocks.findRegistryAppMock.mockResolvedValue({ id: APP_ID, appDid: TARGET_APP_DID, status: 'active' });
});

describe('POST /api/admin/registry/apps/:appId/revoke', () => {
  it('propagates the shared admin-session error response when not an admin', async () => {
    const forbidden = new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    mocks.requireAdminSessionMock.mockResolvedValue({ error: forbidden });

    const res = await POST(revokeRequest() as never, withAppId());

    expect(res.status).toBe(401);
    expect(mocks.updateMock).not.toHaveBeenCalled();
  });

  it('404s for an app id that does not exist', async () => {
    mocks.findRegistryAppMock.mockResolvedValue(null);

    const res = await POST(revokeRequest() as never, withAppId());

    expect(res.status).toBe(404);
  });

  it('flips status to revoked and signs a registry.app.revoked attestation', async () => {
    const res = await POST(revokeRequest() as never, withAppId());
    const body = await res.json();

    expect(body).toEqual({ ok: true });
    expect(mocks.setMock.mock.calls[0][0]).toMatchObject({ status: 'revoked' });
    const attestationCall = mocks.emitAttestationMock.mock.calls[0][0];
    expect(attestationCall.type).toBe('registry.app.revoked');
    expect(attestationCall.issuer_did).toBe(OPERATOR_DID);
    expect(attestationCall.subject_did).toBe(TARGET_APP_DID);
  });

  it('short-circuits without a second attestation when already revoked', async () => {
    mocks.findRegistryAppMock.mockResolvedValue({ id: APP_ID, appDid: TARGET_APP_DID, status: 'revoked' });

    const res = await POST(revokeRequest() as never, withAppId());
    const body = await res.json();

    expect(body.alreadyRevoked).toBe(true);
    expect(mocks.updateMock).not.toHaveBeenCalled();
    expect(mocks.emitAttestationMock).not.toHaveBeenCalled();
  });
});
