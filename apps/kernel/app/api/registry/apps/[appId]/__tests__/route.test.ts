/**
 * Tests for PATCH /api/registry/apps/:appId — providesScopes + dependsOn (#2663).
 *
 * The owner-only gate and the generic field updates predate #2663; the cases here
 * cover how the new declarations are validated and persisted through the same
 * assignment path as `requestedScopes`.
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
  },
}));
vi.mock('drizzle-orm', () => ({ eq: (...args: unknown[]) => ({ eq: args }) }));
vi.mock('@imajin/auth', () => ({
  requireAuth: mocks.requireAuthMock,
  resolveActingDid: (identity: { id: string }) => identity.id,
}));
vi.mock('@/src/lib/kernel/app-declarations', () => ({ validateAppDeclarations: mocks.validateAppDeclarationsMock }));

import { PATCH } from '../route';

const OWNER = 'did:imajin:developer';
const APP_ID = 'app_dykil';

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
  mocks.whereSelectMock.mockResolvedValue([{ id: APP_ID, ownerDid: OWNER, slug: 'dykil' }]);
  mocks.returningMock.mockResolvedValue([{ id: APP_ID }]);
  mocks.validateAppDeclarationsMock.mockImplementation(async (input: { providesScopes?: string[]; dependsOn?: unknown[] }) => ({
    ok: { providesScopes: input.providesScopes ?? [], dependsOn: input.dependsOn ?? [], requestedScopes: [] },
  }));
});

describe('PATCH /api/registry/apps/:appId — providesScopes + dependsOn (#2663)', () => {
  it("validates against the app's slug and persists both fields", async () => {
    const dependsOn = [{ aud: 'jin.imajin.ai', scopes: ['media:read'] }];

    const res = await patch({ providesScopes: ['dykil:read'], dependsOn });

    expect(res.status).toBe(200);
    expect(mocks.validateAppDeclarationsMock).toHaveBeenCalledWith({
      providesScopes: ['dykil:read'],
      dependsOn,
      slug: 'dykil',
    });
    expect(mocks.setMock).toHaveBeenCalledWith(
      expect.objectContaining({ providesScopes: ['dykil:read'], dependsOn }),
    );
  });

  it('updates only the field that was sent', async () => {
    await patch({ providesScopes: ['dykil:read'] });

    const updates = (mocks.setMock.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(updates).toHaveProperty('providesScopes', ['dykil:read']);
    expect(updates).not.toHaveProperty('dependsOn');
  });

  it('clears the list when an empty array is sent', async () => {
    await patch({ dependsOn: [] });

    const updates = (mocks.setMock.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(updates).toHaveProperty('dependsOn', []);
  });

  it('does not run the declarations validator for an unrelated update', async () => {
    const res = await patch({ name: 'Dykil 2' });

    expect(res.status).toBe(200);
    expect(mocks.validateAppDeclarationsMock).not.toHaveBeenCalled();
    const updates = (mocks.setMock.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(updates).not.toHaveProperty('providesScopes');
    expect(updates).not.toHaveProperty('dependsOn');
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
