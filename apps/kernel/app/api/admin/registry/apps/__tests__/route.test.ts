/**
 * Tests for apps/kernel/app/api/admin/registry/apps/route.ts (#1990).
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

vi.mock('nanoid', () => ({ nanoid: () => 'testid0000000000' }));

const mocks = vi.hoisted(() => {
  const orderByMock = vi.fn().mockResolvedValue([]);
  const whereSelectMock = vi.fn(() => ({ orderBy: orderByMock }));
  const fromSelectMock = vi.fn(() => ({ where: whereSelectMock, orderBy: orderByMock }));
  const selectMock = vi.fn(() => ({ from: fromSelectMock }));
  const insertValuesMock = vi.fn(() => ({
    returning: vi.fn().mockResolvedValue([{ id: 'app_testid0000000000', name: 'Admin App', appDid: 'did:imajin:generatedDid' }]),
  }));
  const insertMock = vi.fn(() => ({ values: insertValuesMock }));
  const requireAdminMock = vi.fn();
  const emitAttestationMock = vi.fn().mockResolvedValue(undefined);
  const generateKeypairMock = vi.fn(() => ({ privateKey: 'priv', publicKey: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9' }));
  return { orderByMock, selectMock, insertValuesMock, insertMock, requireAdminMock, emitAttestationMock, generateKeypairMock };
});

vi.mock('@/src/db', () => ({
  db: { select: mocks.selectMock, insert: mocks.insertMock },
  registryApps: {
    id: 'registryApps.id',
    ownerDid: 'registryApps.ownerDid',
    name: 'registryApps.name',
    description: 'registryApps.description',
    appDid: 'registryApps.appDid',
    callbackUrl: 'registryApps.callbackUrl',
    requestedScopes: 'registryApps.requestedScopes',
    status: 'registryApps.status',
    tier: 'registryApps.tier',
    allowedRedirectHosts: 'registryApps.allowedRedirectHosts',
    tokenAudiences: 'registryApps.tokenAudiences',
    revokedAt: 'registryApps.revokedAt',
    createdAt: 'registryApps.createdAt',
    updatedAt: 'registryApps.updatedAt',
  },
}));

vi.mock('@/src/db/schemas/registry', () => ({
  REGISTRY_APP_TIERS: ['first_party', 'third_party'],
}));

vi.mock('drizzle-orm', () => ({
  desc: (...args: unknown[]) => ({ desc: args }),
}));

vi.mock('@imajin/auth', () => ({
  requireAdmin: mocks.requireAdminMock,
  generateKeypair: mocks.generateKeypairMock,
  isValidPublicKey: () => true,
  validateScopes: (scopes: string[]) => ({ valid: scopes, invalid: [] }),
  emitAttestation: mocks.emitAttestationMock,
}));

vi.mock('@/src/lib/auth/crypto', () => ({ didFromPublicKey: () => 'did:imajin:generatedDid' }));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }) }));

import { GET, POST } from '../route';

function makeGetRequest(): Request {
  return new Request('https://kernel.test/api/admin/registry/apps');
}
function makePostRequest(body: Record<string, unknown>): Request {
  return new Request('https://kernel.test/api/admin/registry/apps', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.orderByMock.mockResolvedValue([]);
});

describe('GET /api/admin/registry/apps (#1990)', () => {
  it('rejects a non-admin caller with 401', async () => {
    mocks.requireAdminMock.mockResolvedValue(null);

    const res = await GET(makeGetRequest() as never);

    expect(res.status).toBe(401);
  });

  it('lists apps for an admin caller', async () => {
    mocks.requireAdminMock.mockResolvedValue({ actingAs: 'did:imajin:node' });
    mocks.orderByMock.mockResolvedValue([{ id: 'app_1', status: 'revoked' }]);

    const res = await GET(makeGetRequest() as never);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.apps).toEqual([{ id: 'app_1', status: 'revoked' }]);
  });
});

describe('POST /api/admin/registry/apps (#1990)', () => {
  beforeEach(() => {
    mocks.requireAdminMock.mockResolvedValue({ actingAs: 'did:imajin:node' });
  });

  it('rejects a non-admin caller with 401', async () => {
    mocks.requireAdminMock.mockResolvedValue(null);

    const res = await POST(makePostRequest({ name: 'X', callbackUrl: 'https://x.example.com', ownerDid: 'did:imajin:owner' }) as never);

    expect(res.status).toBe(401);
  });

  it('registers a first-party app with explicit tier/hosts/audiences', async () => {
    const res = await POST(
      makePostRequest({
        name: 'Coffee',
        callbackUrl: 'https://your-node.imajin.ai/coffee',
        ownerDid: 'did:imajin:platform',
        tier: 'first_party',
        allowedRedirectHosts: ['coffee'],
        tokenAudiences: ['coffee'],
      }) as never,
    );

    expect(res.status).toBe(201);
    expect(mocks.insertValuesMock).toHaveBeenCalledOnce();
    const insertedRow = mocks.insertValuesMock.mock.calls[0][0] as Record<string, unknown>;
    expect(insertedRow.tier).toBe('first_party');
    expect(insertedRow.allowedRedirectHosts).toEqual(['coffee']);
    expect(insertedRow.tokenAudiences).toEqual(['coffee']);
    expect(mocks.emitAttestationMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'registry.app.registered', issuer_did: 'did:imajin:node' }),
    );
  });

  it('rejects an invalid tier', async () => {
    const res = await POST(
      makePostRequest({ name: 'X', callbackUrl: 'https://x.example.com', ownerDid: 'did:imajin:owner', tier: 'nonsense' }) as never,
    );

    expect(res.status).toBe(400);
    expect(mocks.insertMock).not.toHaveBeenCalled();
  });

  it('defaults to third_party and derives allowedRedirectHosts from callbackUrl when omitted', async () => {
    const res = await POST(
      makePostRequest({ name: 'X', callbackUrl: 'https://x.example.com/cb', ownerDid: 'did:imajin:owner' }) as never,
    );

    expect(res.status).toBe(201);
    const insertedRow = mocks.insertValuesMock.mock.calls[0][0] as Record<string, unknown>;
    expect(insertedRow.tier).toBe('third_party');
    expect(insertedRow.allowedRedirectHosts).toEqual(['https://x.example.com']);
  });

  it('requires ownerDid', async () => {
    const res = await POST(makePostRequest({ name: 'X', callbackUrl: 'https://x.example.com' }) as never);

    expect(res.status).toBe(400);
    expect(mocks.insertMock).not.toHaveBeenCalled();
  });
});
