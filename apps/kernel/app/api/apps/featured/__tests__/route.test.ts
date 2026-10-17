import { beforeEach, describe, expect, it, vi } from 'vitest';

const { authMock, operatorMock, recordMock, pendingMock, selectMock, updateMock, hashMock } = vi.hoisted(() => ({
  authMock: vi.fn(), operatorMock: vi.fn(), recordMock: vi.fn(), pendingMock: vi.fn(),
  selectMock: vi.fn(), updateMock: vi.fn(), hashMock: vi.fn(),
}));
vi.mock('@imajin/auth', async () => ({
  ...await vi.importActual<typeof import('@imajin/auth')>('@imajin/auth'),
  requireAuth: authMock,
}));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ error: vi.fn() }) }));
vi.mock('@/src/db', () => ({
  db: { select: () => ({ from: () => ({ where: selectMock }) }), update: updateMock },
  registryApps: {},
}));
vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({}), corsOptions: () => new Response(null, { status: 204 }),
}));
vi.mock('@/src/lib/kernel/id', () => ({ generateId: () => 'appfeature_test' }));
vi.mock('@/src/lib/notify/operator-approvals', () => ({
  getOperatorDid: operatorMock,
  isOperatorIdentity: (identity: { id: string; actingFor?: string }, did: string) =>
    identity.id === did && !identity.actingFor,
  computeApprovalContentHash: hashMock,
}));
vi.mock('@/src/lib/notify/operator-approvals-service', () => ({ recordApprovalRequested: recordMock }));
vi.mock('@/src/lib/apps/featured', () => ({ findPendingFeaturedProposal: pendingMock }));

import { POST, OPTIONS } from '../route';
const OPERATOR = 'did:imajin:operator';
const APP = 'did:imajin:app';
const input = { appDid: APP, featured: true };
function request(body: unknown = input) {
  return new Request('https://kernel.test/api/apps/featured', {
    method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
  }) as Parameters<typeof POST>[0];
}
beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ identity: { id: OPERATOR, scope: 'actor', subtype: 'human' } });
  operatorMock.mockResolvedValue(OPERATOR);
  selectMock.mockResolvedValue([{ name: 'Example', status: 'active' }]);
  pendingMock.mockResolvedValue(undefined);
  recordMock.mockResolvedValue(undefined);
  hashMock.mockReturnValue('hash');
});
describe('POST /api/apps/featured', () => {
  it.each([true, false])('stages featured=%s without writing registry or installs', async (featured) => {
    const res = await POST(request({ appDid: APP, featured, enabledApps: ['app'] }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ status: 'pending', proposalId: 'appfeature_test' });
    expect(recordMock).toHaveBeenCalledWith(expect.objectContaining({
      source: 'apps', kind: 'apps:featured', operatorDid: OPERATOR,
      detail: { appDid: APP, featured, appName: 'Example' }, contentHash: 'hash',
    }));
    expect(hashMock).toHaveBeenCalledWith(expect.objectContaining({
      detail: { appDid: APP, featured, appName: 'Example' },
    }));
    expect(updateMock).not.toHaveBeenCalled();
  });
  it('refuses unauthenticated callers before reading the app', async () => {
    authMock.mockResolvedValue({ error: 'Unauthorized', status: 401 });
    expect((await POST(request())).status).toBe(401);
    expect(selectMock).not.toHaveBeenCalled();
    expect(recordMock).not.toHaveBeenCalled();
  });
  it.each([
    { id: APP, scope: 'actor', subtype: 'app' },
    { id: 'did:imajin:owner', scope: 'actor', subtype: 'human' },
    { id: OPERATOR, scope: 'actor', subtype: 'human', actingAs: 'did:imajin:group' },
    { id: 'did:imajin:agent', scope: 'actor', actingFor: OPERATOR },
  ])('refuses self-service and borrowed identities %j', async (identity) => {
    authMock.mockResolvedValue({ identity });
    expect((await POST(request())).status).toBe(403);
    expect(recordMock).not.toHaveBeenCalled();
    expect(selectMock).not.toHaveBeenCalled();
  });
  it.each(['{bad', null, [], {}, { appDid: APP, featured: 'true' }])('rejects invalid body %j', async (body) => {
    expect((await POST(request(body))).status).toBe(400);
    expect(recordMock).not.toHaveBeenCalled();
  });
  it('refuses when no operator is configured', async () => {
    operatorMock.mockResolvedValue(null);
    expect((await POST(request())).status).toBe(403);
  });
  it('rejects unknown apps', async () => {
    selectMock.mockResolvedValue([]);
    expect((await POST(request())).status).toBe(404);
  });
  it('rejects featuring inactive apps but allows proposing unfeature', async () => {
    selectMock.mockResolvedValue([{ name: 'Example', status: 'revoked' }]);
    expect((await POST(request())).status).toBe(409);
    expect(recordMock).not.toHaveBeenCalled();
    expect((await POST(request({ appDid: APP, featured: false }))).status).toBe(201);
  });
  it('reuses identical pending proposals', async () => {
    pendingMock.mockResolvedValue({ proposalId: 'existing' });
    const res = await POST(request());
    expect(await res.json()).toEqual({ status: 'pending', proposalId: 'existing' });
    expect(recordMock).not.toHaveBeenCalled();
  });
  it('reports proposal failures', async () => {
    recordMock.mockRejectedValue(new Error('unavailable'));
    expect((await POST(request())).status).toBe(500);
  });
  it('answers CORS preflight', async () => {
    expect((await OPTIONS(request())).status).toBe(204);
  });
});
