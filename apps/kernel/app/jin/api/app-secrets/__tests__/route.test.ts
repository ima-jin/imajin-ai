import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), operator: vi.fn(), isOperator: vi.fn(), actAs: vi.fn(), select: vi.fn(),
  claimed: vi.fn(), preview: vi.fn(), list: vi.fn(), record: vi.fn(), hash: vi.fn(), stage: vi.fn(),
  pending: vi.fn(),
}));
vi.mock('@/src/lib/apps/secret-staging', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/src/lib/apps/secret-staging')>(),
  stageAppSecret: mocks.stage,
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
  withPendingSecretSync: mocks.pending,
}));
vi.mock('@/src/db', () => ({
  registryApps: {}, db: { select: () => ({ from: () => ({ where: mocks.select }) }) },
}));
import { GET, POST } from '../route';
import { SECRET_REFRESH_NOTICE } from '@/src/lib/apps/declarations-approval';
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
  mocks.select.mockResolvedValue([{ name: 'Fake app', slug: 'fake-app', status: 'active', secrets: [] }]);
  mocks.claimed.mockResolvedValue(true);
  mocks.preview.mockResolvedValue({ ok: [declaration] });
  mocks.hash.mockReturnValue('fake-content-hash');
  mocks.pending.mockImplementation(async (_appDid, _operatorDid, create) => create());
});
describe('app secret operator routes', () => {
  it.each(['set', 'rotate'])('seals %s input outside the proposal and returns no input or input hash', async (action) => {
    mocks.select.mockResolvedValue([{ name: 'Fake app', status: 'active', secrets: [{ name: 'DATABASE_URL', kind: 'operator-supplied' }] }]);
    mocks.stage.mockResolvedValue('fake-random-staging-reference');
    const value = 'OBVIOUSLY_FAKE_OPERATOR_INPUT';
    const response = await POST(req({ appDid, action, name: 'DATABASE_URL', value }));
    expect(response.status).toBe(201);
    expect(mocks.stage).toHaveBeenCalledWith({
      proposalId: 'fake-proposal', operatorDid: 'did:imajin:fake-operator', appDid, name: 'DATABASE_URL', action,
    }, value);
    const detail = { appDid, appName: 'Fake app', name: 'DATABASE_URL', stagingRef: 'fake-random-staging-reference' };
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ kind: `apps:secrets-${action}`, detail }));
    expect(mocks.hash.mock.calls[0][0].detail).toEqual(detail);
    expect(JSON.stringify(mocks.record.mock.calls)).not.toContain(value);
    expect(await response.json()).toEqual({ status: 'pending', proposalId: 'fake-proposal' });
  });
  it.each([undefined, '', 1, 'x'.repeat(65_537), '😀'.repeat(16_385)])('refuses invalid operator input without staging', async (value) => {
    mocks.select.mockResolvedValue([{ name: 'Fake app', status: 'active', secrets: [{ name: 'DATABASE_URL', kind: 'operator-supplied' }] }]);
    expect((await POST(req({ appDid, action: 'set', name: 'DATABASE_URL', value }))).status).toBe(400);
    expect(mocks.stage).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });
  it('redacts staging failure and does not create a proposal', async () => {
    mocks.select.mockResolvedValue([{ name: 'Fake app', status: 'active', secrets: [{ name: 'DATABASE_URL', kind: 'operator-supplied' }] }]);
    mocks.stage.mockRejectedValue(new Error('OBVIOUSLY_FAKE_OPERATOR_INPUT'));
    expect(await (await POST(req({ appDid, action: 'set', name: 'DATABASE_URL', value: 'OBVIOUSLY_FAKE_OPERATOR_INPUT' }))).json())
      .toEqual({ error: 'App-secret proposal unavailable' });
    expect(mocks.record).not.toHaveBeenCalled();
  });
  it('requires authentication and operator identity before any reads or proposals', async () => {
    mocks.auth.mockResolvedValueOnce({ error: 'Unauthorized', status: 401 });
    expect((await POST(req())).status).toBe(401);
    mocks.isOperator.mockReturnValue(false);
    expect((await GET(req())).status).toBe(403);
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });
  it('does not create an empty approval for declared-none secrets', async () => {
    mocks.preview.mockResolvedValue({ ok: [] });
    expect((await POST(req())).status).toBe(409);
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
      summary: "'Fake app' declares new secrets",
      detail: { appDid, appName: 'Fake app', slug: 'fake-app', secrets: [declaration], notApplied: SECRET_REFRESH_NOTICE },
    }));
    expect(mocks.hash.mock.calls[0][0].detail).toEqual(mocks.record.mock.calls[0][0].detail);
  });
  it.each(['rotate', 'revoke'])('stages %s without any returned values', async (action) => {
    mocks.select.mockResolvedValue([{ name: 'Fake app', slug: 'fake-app', status: 'active', secrets: [declaration] }]);
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
  it.each([
    "App 'fake-app' manifest unreadable (HTTP 404)",
    "App 'fake-app' manifest unreadable (HTTP 503)",
    "App 'fake-app' manifest unreadable",
    "App 'fake-app' manifest invalid",
  ])('passes names-only manifest failures without staging a proposal: %s', async (error) => {
    mocks.preview.mockResolvedValue({ error });
    const response = await POST(req());
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error });
    expect(mocks.record).not.toHaveBeenCalled();
  });
  it('returns only allowlisted provenance and lifecycle metadata, never values, claim codes or hashes', async () => {
    const provenance = {
      created: { at: '2026-10-14T00:00:00Z', by: 'did:imajin:fake-registrar' },
      provisioned: { at: null, proposedBy: null, approvedBy: null },
      claimed: { at: null, by: null }, lastSeen: { at: null, by: null },
    };
    const metadata = {
      appDid, slug: 'fake-app', name: 'Fake app', active: true, claimed: false,
      claimExpiresAt: '2026-10-15T00:00:00Z', provenance,
      secrets: [{ ...declaration, status: 'active', timeline: [
        { phase: 'fetched', at: '2026-10-14T01:00:00Z' },
        { phase: 'granted', at: '2026-10-14T00:00:00Z', operatorDid: 'did:imajin:fake-operator', via: 'fixture-approval', grantId: 'fixture-grant' },
      ] }],
    };
    const privateFields = { value: 'OBVIOUSLY_FAKE_VALUE', claimCode: 'OBVIOUSLY_FAKE_CODE', codeHash: 'OBVIOUSLY_FAKE_HASH' };
    mocks.list.mockResolvedValue([{
      ...metadata, ...privateFields,
      provenance: { ...provenance, ...privateFields, created: { ...provenance.created, ...privateFields } },
      secrets: metadata.secrets.map((secret) => ({
        ...secret, ...privateFields, timeline: secret.timeline.map((entry) => ({ ...entry, ...privateFields })),
      })),
    }]);
    const response = await GET(req());
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = await response.json();
    expect(body).toEqual({ apps: [metadata] });
    for (const forbidden of [...Object.keys(privateFields), ...Object.values(privateFields)]) {
      expect(JSON.stringify(body)).not.toContain(forbidden);
    }
  });
  it('returns no metadata when the lifecycle read fails', async () => {
    mocks.list.mockRejectedValue(new Error('OBVIOUSLY_FAKE_PRIVATE_PROVIDER_DETAIL'));
    expect(await (await GET(req())).json()).toEqual({ error: 'App-secret metadata unavailable' });
  });
  it('does not disclose unexpected provider exceptions', async () => {
    mocks.preview.mockRejectedValue(new Error('obvious-fake-placeholder'));
    expect(await (await POST(req())).json()).toEqual({ error: 'App-secret proposal unavailable' });
  });
  it('reuses a pending proposal without fetching or staging again', async () => {
    mocks.pending.mockResolvedValue('existing-proposal');
    const response = await POST(req());
    expect(await response.json()).toEqual({ status: 'pending', proposalId: 'existing-proposal' });
    expect(mocks.pending).toHaveBeenCalledWith(appDid, 'did:imajin:fake-operator', expect.any(Function));
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });
  it('proposes only new slots and reports removals and kind changes as not applied', async () => {
    mocks.select.mockResolvedValue([{ name: 'Fake app', slug: 'fake-app', status: 'active', secrets: [
      declaration, { name: 'REMOVED_SECRET', kind: 'operator-supplied' },
    ] }]);
    const added = { name: 'LEGACY_DATABASE_URL', kind: 'operator-supplied' };
    mocks.preview.mockResolvedValue({ ok: [added, { ...declaration, kind: 'random-64B' }] });
    expect((await POST(req())).status).toBe(201);
    const detail = mocks.record.mock.calls[0][0].detail;
    expect(detail.secrets).toEqual([added]);
    expect(detail.notApplied).toContain('Removal of REMOVED_SECRET');
    expect(detail.notApplied).toContain('Kind change for SESSION_SECRET');
    expect(detail.notApplied).toContain(SECRET_REFRESH_NOTICE);
    expect(mocks.stage).not.toHaveBeenCalled();
  });
  it.each([
    { manifest: [] }, { manifest: [{ ...declaration, kind: 'random-64B' }] }, { manifest: [declaration] },
  ])('does not stage removals, kind changes or unchanged declarations without additions', async ({ manifest }) => {
    mocks.select.mockResolvedValue([{ name: 'Fake app', slug: 'fake-app', status: 'active', secrets: [declaration] }]);
    mocks.preview.mockResolvedValue({ ok: manifest });
    const response = await POST(req());
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain('No new secret declarations. Not applied:');
    expect(mocks.record).not.toHaveBeenCalled();
  });
  it.each([
    { slug: null, secrets: [] },
    { slug: 'fake-app', secrets: [{ name: 'BAD', kind: 'invalid' }] },
    { slug: 'fake-app', secrets: Array.from({ length: 32 }, (_, i) => ({ name: `EXISTING_${i}`, kind: 'operator-supplied' })) },
  ])('refuses invalid source, registered declarations, or oversized union', async (fields) => {
    mocks.select.mockResolvedValue([{ name: 'Fake app', status: 'active', ...fields }]);
    expect((await POST(req())).status).toBe(409);
    expect(mocks.record).not.toHaveBeenCalled();
  });
  it('requires operator identity for sync writes, not just metadata reads', async () => {
    mocks.isOperator.mockReturnValue(false);
    expect((await POST(req())).status).toBe(403);
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.pending).not.toHaveBeenCalled();
  });
});
