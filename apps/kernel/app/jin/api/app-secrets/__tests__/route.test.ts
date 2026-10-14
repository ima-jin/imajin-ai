import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), operator: vi.fn(), isOperator: vi.fn(), actAs: vi.fn(), select: vi.fn(),
  claimed: vi.fn(), preview: vi.fn(), list: vi.fn(), record: vi.fn(), hash: vi.fn(),
}));
vi.mock('@imajin/auth', () => ({ requireAuth: mocks.auth }));
vi.mock('@/src/lib/kernel/cors', () => ({ corsHeaders: () => ({}), corsOptions: () => new Response(null, { status: 204 }) }));
vi.mock('@/src/lib/kernel/id', () => ({ generateId: () => 'fake-proposal' }));
vi.mock('@/src/lib/notify/act-as-guard', () => ({ actAsRefusal: mocks.actAs }));
vi.mock('@/src/lib/notify/operator-approvals', () => ({
  getOperatorDid: mocks.operator, isOperatorIdentity: mocks.isOperator, computeApprovalContentHash: mocks.hash,
}));
vi.mock('@/src/lib/notify/operator-approvals-service', () => ({ recordApprovalRequested: mocks.record }));
vi.mock('@/src/lib/apps/secrets-operator', () => ({
  hasClaimedApp: mocks.claimed, previewAppSecrets: mocks.preview, listOperatorAppSecrets: mocks.list,
}));
vi.mock('@/src/db', () => ({
  registryApps: {}, db: { select: () => ({ from: () => ({ where: mocks.select }) }) },
}));
import { GET, POST } from '../route';
const declaration = { name: 'SESSION_SECRET', kind: 'random-32B' };
const appDid = 'did:imajin:fake-app';
function req(body: unknown = { appDid, action: 'sync' }) {
  return new Request('https://fake.example/jin/api/app-secrets', { method: 'POST', body: JSON.stringify(body) }) as Parameters<typeof POST>[0];
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ identity: { id: 'did:imajin:fake-operator' } });
  mocks.operator.mockResolvedValue('did:imajin:fake-operator');
  mocks.isOperator.mockReturnValue(true);
  mocks.select.mockResolvedValue([{ name: 'Fake app', slug: 'fake-app', status: 'active', secrets: [declaration] }]);
  mocks.claimed.mockResolvedValue(true);
  mocks.preview.mockResolvedValue({ ok: [declaration] });
  mocks.hash.mockReturnValue('fake-content-hash');
});
describe('app secret operator routes', () => {
  it('requires authentication and operator identity before any reads or proposals', async () => {
    mocks.auth.mockResolvedValueOnce({ error: 'Unauthorized', status: 401 });
    expect((await POST(req())).status).toBe(401);
    mocks.isOperator.mockReturnValue(false);
    expect((await GET(req())).status).toBe(403);
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });
  it('refuses act-as writes before reading the app', async () => {
    mocks.actAs.mockReturnValue(Response.json({ error: 'act_as_not_permitted' }, { status: 403 }));
    expect((await POST(req())).status).toBe(403);
    expect(mocks.select).not.toHaveBeenCalled();
  });
  it('snapshots only server-validated manifest recipes into the signed pending card', async () => {
    const response = await POST(req());
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ status: 'pending', proposalId: 'fake-proposal' });
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'apps:secrets-sync', operatorDid: 'did:imajin:fake-operator',
      contentHash: 'fake-content-hash',
      detail: { appDid, appName: 'Fake app', slug: 'fake-app', secrets: [declaration] },
    }));
    expect(mocks.hash.mock.calls[0][0].detail).toEqual(mocks.record.mock.calls[0][0].detail);
  });
  it.each(['rotate', 'revoke'])('stages %s without any returned values', async (action) => {
    const response = await POST(req({ appDid, action, name: 'SESSION_SECRET' }));
    expect(response.status).toBe(201);
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({
      kind: `apps:secrets-${action}`, detail: { appDid, appName: 'Fake app', name: 'SESSION_SECRET' },
    }));
    expect(mocks.preview).not.toHaveBeenCalled();
  });
  it.each([
    { appDid, action: 'sync', secrets: [declaration] },
    { appDid, action: 'rotate', name: 'SESSION_SECRET', value: 'obvious-fake-placeholder' },
    { appDid, action: 'sync', scopes: ['identity:write'] },
    { appDid, action: 'sync', name: 'SESSION_SECRET' },
    { appDid, action: 'fetch', name: 'SESSION_SECRET' },
    null, [],
  ])('refuses extra material, permissions, fetch actions and malformed bodies', async (body) => {
    expect((await POST(req(body))).status).toBe(400);
    expect(mocks.record).not.toHaveBeenCalled();
  });
  it('refuses unclaimed apps and unknown names', async () => {
    mocks.claimed.mockResolvedValueOnce(false);
    expect((await POST(req())).status).toBe(409);
    expect((await POST(req({ appDid, action: 'rotate', name: 'UNDECLARED' }))).status).toBe(400);
    expect(mocks.record).not.toHaveBeenCalled();
  });
  it('refuses unreadable manifests, without staging a proposal', async () => {
    mocks.preview.mockResolvedValue({ error: 'Manifest unreadable' });
    expect((await POST(req())).status).toBe(409);
    expect(mocks.record).not.toHaveBeenCalled();
  });
  it('returns metadata only from the lifecycle read helper', async () => {
    mocks.list.mockResolvedValue([{ appDid, name: 'Fake app', secrets: [declaration] }]);
    expect(await (await GET(req())).json()).toEqual({ apps: [{ appDid, name: 'Fake app', secrets: [declaration] }] });
  });
  it('does not disclose unexpected provider exceptions', async () => {
    mocks.preview.mockRejectedValue(new Error('obvious-fake-placeholder'));
    expect(await (await POST(req())).json()).toEqual({ error: 'App-secret proposal unavailable' });
  });
});
