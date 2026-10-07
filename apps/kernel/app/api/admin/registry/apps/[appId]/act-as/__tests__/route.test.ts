/**
 * Tests for apps/kernel/app/api/admin/registry/apps/[appId]/act-as/route.ts (#2639 / #2644).
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
  registryApps: { id: 'registryApps.id', actAsAllowed: 'registryApps.actAsAllowed' },
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

function actAsRequest(body: unknown): Request {
  return new Request(`https://kernel.test/api/admin/registry/apps/${APP_ID}/act-as`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
function withAppId() {
  return { params: Promise.resolve({ appId: APP_ID }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdminSessionMock.mockResolvedValue({ session: { actingAs: OPERATOR_DID } });
  mocks.findRegistryAppMock.mockResolvedValue({ id: APP_ID, appDid: TARGET_APP_DID, status: 'active' });
});

describe('POST /api/admin/registry/apps/:appId/act-as', () => {
  it('is operator-only: propagates the shared admin-session error and changes nothing', async () => {
    const unauthorized = new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    mocks.requireAdminSessionMock.mockResolvedValue({ error: unauthorized });

    const res = await POST(actAsRequest({ allowed: true }) as never, withAppId());

    expect(res.status).toBe(401);
    expect(mocks.updateMock).not.toHaveBeenCalled();
    expect(mocks.emitAttestationMock).not.toHaveBeenCalled();
  });

  it('400s on invalid JSON', async () => {
    const res = await POST(actAsRequest('{not json') as never, withAppId());

    expect(res.status).toBe(400);
    expect(mocks.updateMock).not.toHaveBeenCalled();
  });

  it.each([[{}], [{ allowed: 'true' }], [{ allowed: 1 }], [{ allowed: null }]])(
    'rejects a non-boolean allowed (%j) with 400',
    async (body) => {
      const res = await POST(actAsRequest(body) as never, withAppId());

      expect(res.status).toBe(400);
      expect(mocks.updateMock).not.toHaveBeenCalled();
    },
  );

  it('404s for an app id that does not exist', async () => {
    mocks.findRegistryAppMock.mockResolvedValue(null);

    const res = await POST(actAsRequest({ allowed: true }) as never, withAppId());

    expect(res.status).toBe(404);
    expect(mocks.updateMock).not.toHaveBeenCalled();
  });

  it('approves act-as for the app and signs a registry.app.act_as.updated attestation', async () => {
    const res = await POST(actAsRequest({ allowed: true }) as never, withAppId());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, actAsAllowed: true });
    expect(mocks.setMock.mock.calls[0][0]).toMatchObject({ actAsAllowed: true });
    const attestation = mocks.emitAttestationMock.mock.calls[0][0];
    expect(attestation.type).toBe('registry.app.act_as.updated');
    expect(attestation.issuer_did).toBe(OPERATOR_DID);
    expect(attestation.subject_did).toBe(TARGET_APP_DID);
    expect(attestation.payload).toEqual({ appId: APP_ID, actAsAllowed: true });
  });

  it('withdraws approval with allowed:false', async () => {
    const res = await POST(actAsRequest({ allowed: false }) as never, withAppId());
    const body = await res.json();

    expect(body).toEqual({ ok: true, actAsAllowed: false });
    expect(mocks.setMock.mock.calls[0][0]).toMatchObject({ actAsAllowed: false });
  });
});
