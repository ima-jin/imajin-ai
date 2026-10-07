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
  const validateAppDeclarationsMock = vi.fn();
  return { orderByMock, selectMock, insertValuesMock, insertMock, requireAdminMock, emitAttestationMock, generateKeypairMock, validateAppDeclarationsMock };
});

// #2663: the validator itself is covered by app-declarations.test.ts.
vi.mock('@/src/lib/kernel/app-declarations', () => ({ validateAppDeclarations: mocks.validateAppDeclarationsMock }));

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
  mocks.validateAppDeclarationsMock.mockImplementation(async (input: { providesScopes?: string[]; dependsOn?: unknown[]; requestedScopes?: string[] }) => ({
    ok: { providesScopes: input.providesScopes ?? [], dependsOn: input.dependsOn ?? [], requestedScopes: input.requestedScopes ?? [] },
  }));
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

describe('POST /api/admin/registry/apps — #2663 providesScopes + dependsOn', () => {
  beforeEach(() => {
    mocks.requireAdminMock.mockResolvedValue({ actingAs: 'did:imajin:node' });
  });

  it('persists validated providesScopes and dependsOn, and keeps own scopes in requestedScopes', async () => {
    const dependsOn = [{ aud: 'jin.imajin.ai', scopes: ['media:read'] }];
    mocks.validateAppDeclarationsMock.mockResolvedValue({
      ok: { providesScopes: ['dykil:read'], dependsOn, requestedScopes: ['dykil:read', 'media:read'] },
    });

    const res = await POST(
      makePostRequest({
        name: 'Dykil',
        callbackUrl: 'https://dykil.example.com/cb',
        ownerDid: 'did:imajin:owner',
        requestedScopes: ['dykil:read', 'media:read'],
        providesScopes: ['dykil:read'],
        dependsOn,
      }) as never,
    );

    expect(res.status).toBe(201);
    expect(mocks.validateAppDeclarationsMock).toHaveBeenCalledWith(
      expect.objectContaining({ providesScopes: ['dykil:read'], dependsOn, requestedScopes: ['dykil:read', 'media:read'] }),
    );
    const insertedRow = mocks.insertValuesMock.mock.calls[0][0] as Record<string, unknown>;
    expect(insertedRow.providesScopes).toEqual(['dykil:read']);
    expect(insertedRow.dependsOn).toEqual(dependsOn);
    expect(insertedRow.requestedScopes).toEqual(['dykil:read', 'media:read']);
    expect(mocks.emitAttestationMock).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ providesScopes: ['dykil:read'], dependsOn }) }),
    );
  });

  it('rejects with 400 and inserts nothing when the declarations are invalid', async () => {
    mocks.validateAppDeclarationsMock.mockResolvedValue({ error: 'providesScopes rejected: media:write' });

    const res = await POST(
      makePostRequest({ name: 'X', callbackUrl: 'https://x.example.com', ownerDid: 'did:imajin:owner', providesScopes: ['media:write'] }) as never,
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain('media:write');
    expect(mocks.insertMock).not.toHaveBeenCalled();
    expect(mocks.emitAttestationMock).not.toHaveBeenCalled();
  });
});

// #2674: scope namespaces are reserved by registered slug, so the admin route takes the slug
// the app's `providesScopes` must sit in (and persists it).
describe('POST /api/admin/registry/apps — slug (#2674)', () => {
  const base = { name: 'Dykil', callbackUrl: 'https://dykil.example.com/cb', ownerDid: 'did:imajin:owner' };

  beforeEach(() => {
    mocks.requireAdminMock.mockResolvedValue({ actingAs: 'did:imajin:node' });
  });

  it('validates providesScopes against the supplied slug and persists it', async () => {
    const res = await POST(makePostRequest({ ...base, slug: 'dykil', providesScopes: ['dykil:read'] }) as never);

    expect(res.status).toBe(201);
    expect(mocks.validateAppDeclarationsMock).toHaveBeenCalledWith(expect.objectContaining({ slug: 'dykil', providesScopes: ['dykil:read'] }));
    const insertedRow = mocks.insertValuesMock.mock.calls[0][0] as Record<string, unknown>;
    expect(insertedRow.slug).toBe('dykil');
    expect(mocks.emitAttestationMock).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ slug: 'dykil' }) }),
    );
  });

  it('passes a null slug when none is supplied, so a slug-less app cannot declare scopes', async () => {
    mocks.validateAppDeclarationsMock.mockResolvedValue({ error: 'providesScopes rejected: dykil:read — without a registered slug' });

    const res = await POST(makePostRequest({ ...base, providesScopes: ['dykil:read'] }) as never);

    expect(res.status).toBe(400);
    expect(mocks.validateAppDeclarationsMock).toHaveBeenCalledWith(expect.objectContaining({ slug: null }));
    expect(mocks.insertMock).not.toHaveBeenCalled();
  });

  it('stores a null slug for an app that declares nothing and supplies none', async () => {
    const res = await POST(makePostRequest(base) as never);

    expect(res.status).toBe(201);
    expect((mocks.insertValuesMock.mock.calls[0][0] as Record<string, unknown>).slug).toBeNull();
  });

  it.each([['Dykil'], ['has space'], ['9lives'], ['x'.repeat(40)], [42]])('rejects a malformed slug (%j) with 400, inserting nothing', async (slug) => {
    const res = await POST(makePostRequest({ ...base, slug }) as never);

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/slug/);
    expect(mocks.insertMock).not.toHaveBeenCalled();
  });

  it('answers 409, not 500, and emits no attestation when the slug is already registered', async () => {
    mocks.insertValuesMock.mockReturnValueOnce({
      returning: vi.fn().mockRejectedValue(Object.assign(new Error('duplicate key value violates unique constraint "uniq_registry_apps_slug"'), { code: '23505' })),
    });

    const res = await POST(makePostRequest({ ...base, slug: 'dykil' }) as never);

    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('dykil');
    expect(mocks.emitAttestationMock).not.toHaveBeenCalled();
  });

  it('still surfaces an unrelated insert failure', async () => {
    mocks.insertValuesMock.mockReturnValueOnce({ returning: vi.fn().mockRejectedValue(new Error('db down')) });

    await expect(POST(makePostRequest({ ...base, slug: 'dykil' }) as never)).rejects.toThrow('db down');
  });
});
