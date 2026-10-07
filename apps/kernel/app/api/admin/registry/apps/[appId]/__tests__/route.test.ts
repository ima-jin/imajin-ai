/**
 * Tests for PATCH /api/admin/registry/apps/:appId (#2638 / #2641) — the
 * operator's approval of which event types a registered app may emit.
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
  const selectWhereMock = vi.fn(() => ({ limit: limitMock }));
  const selectFromMock = vi.fn(() => ({ where: selectWhereMock }));
  const selectMock = vi.fn(() => ({ from: selectFromMock }));

  const returningMock = vi.fn();
  const updateWhereMock = vi.fn(() => ({ returning: returningMock }));
  const setMock = vi.fn(() => ({ where: updateWhereMock }));
  const updateMock = vi.fn(() => ({ set: setMock }));

  const requireAdminSessionMock = vi.fn();
  const emitAttestationMock = vi.fn().mockResolvedValue(undefined);
  return { limitMock, selectMock, returningMock, setMock, updateMock, requireAdminSessionMock, emitAttestationMock };
});

vi.mock('@/src/db', () => ({
  db: { select: mocks.selectMock, update: mocks.updateMock },
  registryApps: { id: 'registryApps.id', appDid: 'registryApps.appDid', emittableEvents: 'registryApps.emittableEvents' },
}));
vi.mock('drizzle-orm', () => ({ eq: (...args: unknown[]) => ({ eq: args }) }));
vi.mock('@imajin/auth', () => ({ emitAttestation: mocks.emitAttestationMock }));
vi.mock('@/src/lib/kernel/app-registry-admin', () => ({ requireAdminSession: mocks.requireAdminSessionMock }));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }) }));

import { PATCH } from '../route';

const APP_ID = 'app_coffee';
const APP_DID = 'did:imajin:app_coffee';
const OPERATOR_DID = 'did:imajin:operator';

function patch(body: unknown): Promise<Response> {
  const request = new Request(`https://kernel.test/api/admin/registry/apps/${APP_ID}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return PATCH(request as never, { params: Promise.resolve({ appId: APP_ID }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdminSessionMock.mockResolvedValue({ session: { actingAs: OPERATOR_DID } });
  mocks.limitMock.mockResolvedValue([{ id: APP_ID, appDid: APP_DID, emittableEvents: ['tip.sent'] }]);
  mocks.returningMock.mockResolvedValue([{ id: APP_ID, appDid: APP_DID, emittableEvents: ['tip.granted', 'tip.sent'] }]);
});

describe('PATCH /api/admin/registry/apps/:appId — admin gate', () => {
  it('returns the 401 from the admin gate for a non-admin caller, touching nothing', async () => {
    mocks.requireAdminSessionMock.mockResolvedValue({
      error: new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
    });

    const res = await patch({ emittableEvents: ['tip.granted'] });

    expect(res.status).toBe(401);
    expect(mocks.selectMock).not.toHaveBeenCalled();
    expect(mocks.updateMock).not.toHaveBeenCalled();
    expect(mocks.emitAttestationMock).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/admin/registry/apps/:appId — approving an emit list', () => {
  it('replaces the list with exactly what the operator sent (normalised) and returns it', async () => {
    const res = await patch({ emittableEvents: ['tip.sent', 'tip.granted', 'tip.sent'] });

    expect(res.status).toBe(200);
    expect(mocks.setMock).toHaveBeenCalledWith(expect.objectContaining({ emittableEvents: ['tip.granted', 'tip.sent'] }));
    expect((await res.json()).app.emittableEvents).toEqual(['tip.granted', 'tip.sent']);
  });

  it('an empty list withdraws every approval', async () => {
    mocks.returningMock.mockResolvedValue([{ id: APP_ID, appDid: APP_DID, emittableEvents: [] }]);

    const res = await patch({ emittableEvents: [] });

    expect(res.status).toBe(200);
    expect(mocks.setMock).toHaveBeenCalledWith(expect.objectContaining({ emittableEvents: [] }));
  });

  it('writes nothing but the emit list (no scope, audience, status or tier change)', async () => {
    await patch({ emittableEvents: ['tip.granted'], tier: 'first_party', tokenAudiences: ['evil'], providesScopes: ['x:y'], status: 'active' });

    const updates = (mocks.setMock.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(Object.keys(updates).sort((a, b) => a.localeCompare(b))).toEqual(['emittableEvents', 'updatedAt']);
  });

  it('signs the change into the audit trail with the before and after lists, attributed to the operator', async () => {
    await patch({ emittableEvents: ['tip.granted', 'tip.sent'] });

    expect(mocks.emitAttestationMock).toHaveBeenCalledWith({
      issuer_did: OPERATOR_DID,
      subject_did: APP_DID,
      type: 'registry.app.emittable-events.updated',
      context_id: APP_ID,
      context_type: 'registry_app',
      payload: { appId: APP_ID, previous: ['tip.sent'], emittableEvents: ['tip.granted', 'tip.sent'] },
    });
  });

  it('still succeeds when the attestation fails (the approval is the source of truth)', async () => {
    mocks.emitAttestationMock.mockRejectedValueOnce(new Error('attestation down'));

    const res = await patch({ emittableEvents: ['tip.granted'] });

    expect(res.status).toBe(200);
  });
});

describe('PATCH /api/admin/registry/apps/:appId — refusals', () => {
  it('returns 404 for an unknown app, writing nothing', async () => {
    mocks.limitMock.mockResolvedValue([]);

    const res = await patch({ emittableEvents: ['tip.granted'] });

    expect(res.status).toBe(404);
    expect(mocks.updateMock).not.toHaveBeenCalled();
    expect(mocks.emitAttestationMock).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid JSON', 'not json'],
    ['a JSON null', 'null'],
    ['a body without emittableEvents', { name: 'x' }],
  ])('returns 400 for %s', async (_label, body) => {
    const res = await patch(body);

    expect(res.status).toBe(400);
    expect(mocks.updateMock).not.toHaveBeenCalled();
  });

  it.each([
    ['a wildcard', ['tip.*']],
    ['an uppercase type', ['Tip.Granted']],
    ['a non-string entry', [7]],
    ['a non-array value', 'tip.granted'],
  ])('returns 400 for %s, writing nothing', async (_label, emittableEvents) => {
    const res = await patch({ emittableEvents });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('emittableEvents');
    expect(mocks.updateMock).not.toHaveBeenCalled();
    expect(mocks.emitAttestationMock).not.toHaveBeenCalled();
  });
});
