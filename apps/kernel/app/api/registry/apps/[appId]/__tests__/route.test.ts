/**
 * Tests for PATCH /api/registry/apps/:appId — providesScopes (owner-editable) and dependsOn
 * (operator-only, rejected here) (#2663).
 *
 * The owner-only gate and the generic field updates predate #2663; the cases here
 * cover how `providesScopes` is validated and persisted through the same assignment
 * path as `requestedScopes`, and that an owner can never self-assign `dependsOn`.
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
  const whereSelectMock = vi.fn();
  const fromSelectMock = vi.fn(() => ({ where: whereSelectMock }));
  const selectMock = vi.fn(() => ({ from: fromSelectMock }));
  const returningMock = vi.fn();
  const whereUpdateMock = vi.fn(() => ({ returning: returningMock }));
  const setMock = vi.fn(() => ({ where: whereUpdateMock }));
  const updateMock = vi.fn(() => ({ set: setMock }));
  return {
    whereSelectMock,
    selectMock,
    returningMock,
    setMock,
    updateMock,
    requireAuthMock: vi.fn(),
    validateAppDeclarationsMock: vi.fn(),
  };
});

vi.mock('@/src/db', () => ({
  db: { select: mocks.selectMock, update: mocks.updateMock },
  registryApps: {
    id: 'registryApps.id',
    ownerDid: 'registryApps.ownerDid',
    slug: 'registryApps.slug',
    requestedScopes: 'registryApps.requestedScopes',
    providesScopes: 'registryApps.providesScopes',
    dependsOn: 'registryApps.dependsOn',
  },
}));
vi.mock('drizzle-orm', () => ({ eq: (...args: unknown[]) => ({ eq: args }) }));
vi.mock('@imajin/auth', async () => {
  // The ceiling is a pure function with its own tests (packages/auth/tests/app-scopes.test.ts); use the real one.
  const actual = await vi.importActual<typeof import('@imajin/auth')>('@imajin/auth');
  return {
    approvedScopeCeiling: actual.approvedScopeCeiling,
    requireAuth: mocks.requireAuthMock,
    resolveActingDid: (identity: { id: string }) => identity.id,
  };
});
vi.mock('@/src/lib/kernel/app-declarations', () => ({
  validateAppDeclarations: mocks.validateAppDeclarationsMock,
  DEPENDS_ON_OPERATOR_ONLY_ERROR: 'dependsOn is operator-only',
}));

import { PATCH } from '../route';

const OWNER = 'did:imajin:developer';
const APP_ID = 'app_dykil';

/** The row as `apps.provision` leaves it: the operator-approved list recorded in requested/provides/dependsOn. */
function existingRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: APP_ID,
    ownerDid: OWNER,
    slug: 'dykil',
    requestedScopes: ['dykil:read', 'dykil:write', 'media:read'],
    providesScopes: ['dykil:read', 'dykil:write'],
    dependsOn: [{ aud: 'jin.imajin.ai', scopes: ['media:read'] }],
    ...overrides,
  };
}

function patch(body: Record<string, unknown>): Promise<Response> {
  const request = new Request(`https://kernel.test/api/registry/apps/${APP_ID}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return PATCH(request as never, { params: Promise.resolve({ appId: APP_ID }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuthMock.mockResolvedValue({ identity: { id: OWNER } });
  mocks.whereSelectMock.mockResolvedValue([existingRow()]);
  mocks.returningMock.mockResolvedValue([{ id: APP_ID }]);
  mocks.validateAppDeclarationsMock.mockImplementation(async (input: { providesScopes?: string[]; dependsOn?: unknown[] }) => ({
    ok: { providesScopes: input.providesScopes ?? [], dependsOn: input.dependsOn ?? [], requestedScopes: [] },
  }));
});

describe('PATCH /api/registry/apps/:appId — providesScopes (#2663)', () => {
  it("validates against the app's slug and persists it", async () => {
    const res = await patch({ providesScopes: ['dykil:read'] });

    expect(res.status).toBe(200);
    expect(mocks.validateAppDeclarationsMock).toHaveBeenCalledWith({
      providesScopes: ['dykil:read'],
      slug: 'dykil',
    });
    expect(mocks.setMock).toHaveBeenCalledWith(expect.objectContaining({ providesScopes: ['dykil:read'] }));
  });

  it('clears the list when an empty array is sent', async () => {
    await patch({ providesScopes: [] });

    const updates = (mocks.setMock.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(updates).toHaveProperty('providesScopes', []);
  });

  it('does not run the declarations validator for an unrelated update', async () => {
    const res = await patch({ name: 'Dykil 2' });

    expect(res.status).toBe(200);
    expect(mocks.validateAppDeclarationsMock).not.toHaveBeenCalled();
    const updates = (mocks.setMock.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(updates).not.toHaveProperty('providesScopes');
    expect(updates).not.toHaveProperty('dependsOn');
  });

  it.each([
    ['a kernel-media dependency', [{ aud: 'jin.imajin.ai', scopes: ['media:read'] }]],
    ['an empty list', []],
    ['a malformed value', 'jin.imajin.ai'],
  ])('rejects dependsOn (%s) with 400: an owner cannot self-assign it, and nothing is written', async (_label, dependsOn) => {
    const res = await patch({ dependsOn });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe('dependsOn is operator-only');
    expect(mocks.validateAppDeclarationsMock).not.toHaveBeenCalled();
    expect(mocks.updateMock).not.toHaveBeenCalled();
  });

  it('rejects dependsOn even when sent alongside valid owner-editable fields, writing none of them', async () => {
    const res = await patch({
      name: 'Dykil 2',
      providesScopes: ['dykil:read'],
      dependsOn: [{ aud: 'jin.imajin.ai', scopes: ['media:read', 'media:write'] }],
    });

    expect(res.status).toBe(400);
    expect(mocks.updateMock).not.toHaveBeenCalled();
  });

  it('rejects with 400 and writes nothing when the declarations are invalid', async () => {
    mocks.validateAppDeclarationsMock.mockResolvedValue({ error: 'providesScopes rejected: media:write' });

    const res = await patch({ providesScopes: ['media:write'] });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain('media:write');
    expect(mocks.updateMock).not.toHaveBeenCalled();
  });

  it('keeps the owner-only gate: a non-owner gets 403 and nothing is validated or written', async () => {
    mocks.requireAuthMock.mockResolvedValue({ identity: { id: 'did:imajin:someone-else' } });

    const res = await patch({ providesScopes: ['dykil:read'] });

    expect(res.status).toBe(403);
    expect(mocks.validateAppDeclarationsMock).not.toHaveBeenCalled();
    expect(mocks.updateMock).not.toHaveBeenCalled();
  });

  it('returns 401 when unauthenticated', async () => {
    mocks.requireAuthMock.mockResolvedValue({ error: 'nope', status: 401 });

    const res = await patch({ providesScopes: ['dykil:read'] });

    expect(res.status).toBe(401);
    expect(mocks.updateMock).not.toHaveBeenCalled();
  });
});

// #2674: `providesScopes` edits made after approval bypassed the /jin card. The approved
// list (recorded in the row at provision time) is now the ceiling: edits may narrow it,
// never widen it.
describe('PATCH /api/registry/apps/:appId — the approved list is the ceiling (#2674)', () => {
  it('rejects a providesScope the operator never approved, writing nothing', async () => {
    const res = await patch({ providesScopes: ['dykil:read', 'dykil:admin'] });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain('dykil:admin');
    expect(body.error).toMatch(/approved list/);
    expect(mocks.updateMock).not.toHaveBeenCalled();
  });

  it('allows narrowing the approved list', async () => {
    const res = await patch({ providesScopes: ['dykil:read'] });

    expect(res.status).toBe(200);
    expect(mocks.setMock).toHaveBeenCalledWith(expect.objectContaining({ providesScopes: ['dykil:read'] }));
  });

  it('allows re-adding a scope that was approved and later narrowed away', async () => {
    mocks.whereSelectMock.mockResolvedValue([existingRow({ providesScopes: ['dykil:read'] })]);

    const res = await patch({ providesScopes: ['dykil:read', 'dykil:write'] });

    expect(res.status).toBe(200);
  });

  it('cannot spend headroom raised in the SAME request: requestedScopes is not trusted from the body', async () => {
    const res = await patch({
      requestedScopes: ['dykil:read', 'dykil:write', 'media:read', 'dykil:admin'],
      providesScopes: ['dykil:admin'],
    });

    expect(res.status).toBe(400);
    expect(mocks.updateMock).not.toHaveBeenCalled();
  });

  it('rejects widening requestedScopes on a provisioned (slugged) app, writing nothing', async () => {
    const res = await patch({ requestedScopes: ['dykil:read', 'wallet:write'] });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain('wallet:write');
    expect(mocks.updateMock).not.toHaveBeenCalled();
  });

  it('allows narrowing requestedScopes on a provisioned app', async () => {
    const res = await patch({ requestedScopes: ['dykil:read'] });

    expect(res.status).toBe(200);
    expect(mocks.setMock).toHaveBeenCalledWith(expect.objectContaining({ requestedScopes: ['dykil:read'] }));
  });

  it('treats the approved dependsOn scopes as part of the ceiling for requestedScopes', async () => {
    const res = await patch({ requestedScopes: ['dykil:read', 'media:read'] });

    expect(res.status).toBe(200);
  });

  it('still lets a slug-less self-service app edit its own requestedScopes freely', async () => {
    mocks.whereSelectMock.mockResolvedValue([existingRow({ slug: null, requestedScopes: ['profile:read'], providesScopes: [], dependsOn: [] })]);

    const res = await patch({ requestedScopes: ['profile:read', 'connections:read'] });

    expect(res.status).toBe(200);
    expect(mocks.setMock).toHaveBeenCalledWith(expect.objectContaining({ requestedScopes: ['profile:read', 'connections:read'] }));
  });

  it('gives a slug-less app no providesScopes headroom (validated by slug first)', async () => {
    mocks.whereSelectMock.mockResolvedValue([existingRow({ slug: null, requestedScopes: [], providesScopes: [], dependsOn: [] })]);
    mocks.validateAppDeclarationsMock.mockResolvedValue({ error: 'providesScopes rejected: dykil:read — without a registered slug' });

    const res = await patch({ providesScopes: ['dykil:read'] });

    expect(res.status).toBe(400);
    expect(mocks.validateAppDeclarationsMock).toHaveBeenCalledWith({ providesScopes: ['dykil:read'], slug: null });
    expect(mocks.updateMock).not.toHaveBeenCalled();
  });
});
