import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  rename: vi.fn(),
  scopes: vi.fn(),
  status: vi.fn(),
  granteeStatus: vi.fn(),
  googleRows: [] as Record<string, unknown>[],
}));
vi.mock('@/src/lib/kernel/connector-owner-did', () => ({ resolveConnectorOwnerDid: h.auth }));
vi.mock('@/src/lib/kernel/connector-registry-store', () => ({
  listConnectorRegistrations: h.list, createConnectorConnection: h.create, renameConnectorConnection: h.rename,
}));
vi.mock('@/src/lib/kernel/scope-manifest-core', () => ({ readActiveConnectorScopes: h.scopes }));
vi.mock('@/src/lib/vault', () => ({ vaultFieldStatus: h.status, vaultFieldStatusForGrantee: h.granteeStatus }));
vi.mock('@/src/db', () => ({
  db: { select: () => ({ from: () => ({ where: async () => h.googleRows }) }) },
  googleWorkspaceState: { ownerDid: 'owner_did' },
}));
vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({}), corsOptions: () => new Response(null, { status: 204 }),
}));

import { GET, POST, PATCH, OPTIONS } from '../route';
const context = (id = 'google') => ({ params: Promise.resolve({ id }) });
function request(method = 'GET', body?: unknown, query = '') {
  return new NextRequest(`https://example.test/connections/api/connectors/google/connections${query}`, {
    method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.googleRows = [];
  h.auth.mockResolvedValue({ ok: true, ownerDid: 'did:owner' });
  h.list.mockResolvedValue([]);
  h.scopes.mockResolvedValue([]);
  h.status.mockResolvedValue('absent');
  h.granteeStatus.mockResolvedValue('ready');
  h.create.mockResolvedValue({ slot: 'work', label: 'Work' });
  h.rename.mockResolvedValue({ slot: 'work', label: 'Renamed' });
});

describe('connection metadata API', () => {
  it.each(['github', 'google', 'quickbooks'])('hides removed %s slots, including stale Google account state', async id => {
    h.list.mockResolvedValue([{ provider: id, slot: 'work', status: 'removed', label: 'Removed account' }]);
    h.googleRows = [{ slot: 'work', accountEmail: 'stale@example.test' }];
    const body = await (await GET(request(), context(id))).json();
    expect(body.connections.map((row: { slot: string }) => row.slot)).toEqual(['primary']);
    expect(h.status).not.toHaveBeenCalledWith(`${id}-oauth:did:owner:work`);
  });
  it('rejects unknown providers and unauthenticated callers without reading rows', async () => {
    expect((await GET(request(), context('unknown'))).status).toBe(404);
    h.auth.mockResolvedValue({ ok: false, error: 'Unauthorized', status: 401 });
    for (const [handler, method] of [[GET, 'GET'], [POST, 'POST'], [PATCH, 'PATCH']] as const) {
      expect((await handler(request(method, method === 'GET' ? undefined : {}), context())).status).toBe(401);
    }
    expect(h.list).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
    expect(h.rename).not.toHaveBeenCalled();
  });

  it('lists a selectable primary for a legacy owner with no registry metadata', async () => {
    const response = await GET(request(), context());
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ ownerDid: 'did:owner', connections: [{
      slot: 'primary', label: 'primary', accountEmail: null, connected: false, configured: false, scopes: [],
    }] });
    expect(h.list).toHaveBeenCalledWith('did:owner');
  });

  it('finds legacy OAuth primary tokens even if the registry projection never recorded them', async () => {
    h.status.mockImplementation(async (field: string) => field === 'google-oauth:did:owner' ? 'ready' : 'absent');
    const body = await (await GET(request(), context())).json();
    expect(body.connections[0].connected).toBe(true);
    expect(h.status).toHaveBeenCalledWith('google-oauth:did:owner');
  });

  it('never lends primary credentials, scope snapshots or email to an empty new slot', async () => {
    h.status.mockImplementation(async (field: string) => field.endsWith(':work') ? 'absent' : 'ready');
    h.list.mockResolvedValue([
      { provider: 'google', slot: 'primary', label: 'Personal', sealedKeyField: 'google-oauth:did:owner', scopes: ['stale:snapshot'] },
      { provider: 'google', slot: 'work', label: 'Work', sealedKeyField: null },
      { provider: 'github', slot: 'unrelated', sealedKeyField: 'github-oauth:did:owner' },
    ]);
    h.googleRows = [
      { slot: 'primary', accountEmail: 'personal@example.test' },
      { slot: 'work', accountEmail: 'work@example.test' },
    ];
    h.scopes.mockImplementation(async (_owner: string, _channel: string, _connector: string, slot: string) =>
      slot === 'primary' ? ['google:gmail-read'] : []);
    const body = await (await GET(request(), context())).json();
    expect(body.connections).toEqual([
      { slot: 'primary', label: 'Personal', accountEmail: 'personal@example.test', connected: true, configured: true, scopes: ['google:gmail-read'] },
      { slot: 'work', label: 'Work', accountEmail: 'work@example.test', connected: false, configured: false, scopes: [] },
    ]);
    expect(h.status).toHaveBeenCalledWith('google-oauth:did:owner');
    expect(h.status).toHaveBeenCalledWith('google-oauth:did:owner:work');
  });

  it('checks static-secret custody for the connector grantee rather than assuming registry status grants access', async () => {
    h.list.mockResolvedValue([{ provider: 'warp', slot: 'primary', sealedKeyField: 'warp-agent-key:did:owner', status: 'active' }]);
    h.granteeStatus.mockResolvedValue('absent');
    const body = await (await GET(request(), context('warp'))).json();
    expect(body.connections[0].connected).toBe(false);
    expect(h.granteeStatus).toHaveBeenCalledWith('warp-agent-key:did:owner', 'did:imajin:warp-connector');
    expect(h.status).not.toHaveBeenCalled();
  });

  it('creates only metadata for the authenticated owner and defaults label to slot in the store', async () => {
    expect((await POST(request('POST', { slot: 'work', label: ' Work ' }), context())).status).toBe(201);
    expect(h.create).toHaveBeenCalledWith('did:owner', 'google', 'work', 'Work');
    expect(h.status).not.toHaveBeenCalled();
    expect(h.scopes).not.toHaveBeenCalled();
    await POST(request('POST', {}), context());
    expect(h.create).toHaveBeenLastCalledWith('did:owner', 'google', 'primary', undefined);
  });

  it('validates selectors and labels, including non-string values', async () => {
    for (const body of [{ slot: 'Bad' }, { slot: ['work'] }, { label: '' }, { label: 'x'.repeat(101) }]) {
      expect((await POST(request('POST', body), context())).status).toBe(400);
    }
    expect((await PATCH(request('PATCH', {}, '?slot=work'), context())).status).toBe(400);
    expect(h.create).not.toHaveBeenCalled();
  });

  it('renames exactly the requested owned slot and handles missing connections', async () => {
    expect((await PATCH(request('PATCH', { label: 'Renamed' }, '?slot=work'), context())).status).toBe(200);
    expect(h.rename).toHaveBeenCalledWith('did:owner', 'google', 'work', 'Renamed');
    h.rename.mockResolvedValue(undefined);
    expect((await PATCH(request('PATCH', { label: 'Missing' }, '?slot=missing'), context())).status).toBe(404);
  });

  it('renames the visible synthetic primary with an omitted selector', async () => {
    h.rename.mockResolvedValue({ slot: 'primary', label: 'Personal' });
    const response = await PATCH(request('PATCH', { label: 'Personal' }), context());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ slot: 'primary', label: 'Personal' });
    expect(h.rename).toHaveBeenCalledWith('did:owner', 'google', 'primary', 'Personal');
    expect(h.create).not.toHaveBeenCalled();
    expect(h.scopes).not.toHaveBeenCalled();
    expect(h.status).not.toHaveBeenCalled();
  });

  it('reports conflicts and fails closed on read/write outages', async () => {
    h.create.mockRejectedValue(new Error('connection_exists'));
    expect((await POST(request('POST', { slot: 'work' }), context())).status).toBe(409);
    h.create.mockRejectedValue(new Error('database unavailable'));
    expect((await POST(request('POST', { slot: 'work' }), context())).status).toBe(500);
    h.list.mockRejectedValue(new Error('database unavailable'));
    expect((await GET(request(), context())).status).toBe(500);
    expect(OPTIONS(request()).status).toBe(204);
  });
});
