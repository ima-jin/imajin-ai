import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { setVaultInternalApiKey } from '../../../../../../packages/auth/tests/support/internal-post-test-env';

const { db, tables, authSpy, publish, resolveMembers, registrations } = vi.hoisted(() => {
  const tables = Object.fromEntries(['connections', 'nicknames', 'pods', 'podMembers', 'podLinks', 'registryApps', 'googleWorkspaceState']
    .map((name) => [name, new Proxy({}, { get: (_target, key) => `${name}.${String(key)}` })]));
  const rows = [{ id: 'pod', ownerDid: 'did:imajin:org', role: 'member', nickname: 'Friend', pod: { id: 'pod' } }];
  const chain = {
    from: () => chain, where: () => chain, set: () => chain, values: () => chain,
    innerJoin: () => chain, onConflictDoUpdate: () => chain,
    returning: async () => rows, limit: async () => rows,
    then: (resolve: (value: typeof rows) => unknown) => Promise.resolve(rows).then(resolve),
  };
  return {
    tables,
    db: {
      select: vi.fn(() => chain), insert: vi.fn(() => chain),
      update: vi.fn(() => chain), delete: vi.fn(() => chain),
    },
    authSpy: vi.fn(), publish: vi.fn(async () => undefined),
    resolveMembers: vi.fn(async () => new Set(['did:imajin:org'])),
    registrations: {
      listConnectorRegistrations: vi.fn(async () => []),
      createConnectorConnection: vi.fn(async () => ({ slot: 'primary', label: 'Test' })),
      renameConnectorConnection: vi.fn(async () => ({ slot: 'primary', label: 'Test' })),
    },
  };
});

vi.mock('@/src/db', () => ({ db, ...tables }));
vi.mock('@imajin/auth', async () => {
  const { requireAuth } = await import('../../../../../../packages/auth/src/require-auth');
  const { requireAppAuth } = await import('../../../../../../packages/auth/src/require-app-auth');
  const { resolveActingDid } = await import('../../../../../../packages/auth/src/acting-did');
  return {
    requireAuth: (...args: Parameters<typeof requireAuth>) => {
      authSpy(...args);
      return requireAuth(...args);
    },
    resolveActingDid,
    requireAppAuth,
    isVerifiedTier: () => true,
  };
});
vi.mock('@imajin/auth/delegation-policy', () => ({ enforceRoutePolicy: () => undefined }));
vi.mock('@imajin/bus', () => ({ publish }));
vi.mock('@imajin/trust-graph', () => ({ resolvePodMembers: resolveMembers }));
vi.mock('@/src/lib/auth/foreign-agent-stub', () => ({ blockForeignAgentStub: async () => false }));
vi.mock('@/src/lib/kernel/id', () => ({ generateId: () => 'pod' }));
vi.mock('@/src/lib/kernel/connector-registry', () => ({
  getConnector: () => ({ id: 'test', channel: 'test', connectorDid: 'did:imajin:test', ingestionPattern: 'native' }),
}));
vi.mock('@/src/lib/kernel/connector-registry-store', () => registrations);
vi.mock('@/src/lib/kernel/scope-manifest-core', () => ({ readActiveConnectorScopes: async () => [] }));
vi.mock('@/src/lib/vault', () => ({
  vaultFieldStatus: async () => 'absent', vaultFieldStatusForGrantee: async () => 'absent',
}));
vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({}), corsOptions: () => new Response(),
  withCors: (response: Response) => response,
}));

import * as disconnect from '../connections/[did]/route';
import * as nickname from '../connections/[did]/nickname/route';
import * as nicknames from '../nicknames/resolve/route';
import * as pods from '../pods/route';
import * as pod from '../pods/[id]/route';
import * as links from '../pods/[id]/links/route';
import * as members from '../pods/[id]/members/route';
import * as resolve from '../pods/[id]/resolve/route';
import * as connectorConnections from '../connectors/[id]/connections/route';

const ORG = 'did:imajin:org';
const props = { params: Promise.resolve({ id: 'pod', did: 'did:imajin:other' }) };
let allowedServices: string[] | null;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('AUTH_SERVICE_URL', 'https://auth.test');
  setVaultInternalApiKey('test-key');
  allowedServices = ['connections'];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/api/session')) return Response.json({ did: 'did:imajin:person', scope: 'actor', tier: 'established' });
    if (url.includes('/controllers/')) return Response.json({ valid: true, role: 'maintainer', allowedServices });
    if (url.endsWith('/verify')) return Response.json({ chain: { valid: true } });
    throw new Error(`Unexpected URL: ${url}`);
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  setVaultInternalApiKey(undefined);
});

const routes = [
  ['disconnect', (req: NextRequest) => disconnect.DELETE(req, props), 200],
  ['nickname read', (req: NextRequest) => nickname.GET(req, props), 200],
  ['nickname update', (req: NextRequest) => nickname.PATCH(req, props), 200],
  ['nickname delete', (req: NextRequest) => nickname.DELETE(req, props), 200],
  ['nicknames resolve', (req: NextRequest) => nicknames.POST(req), 200],
  ['pods list', (req: NextRequest) => pods.GET(req), 200],
  ['pods create via graph guard', (req: NextRequest) => pods.POST(req), 201],
  ['pod read', (req: NextRequest) => pod.GET(req, props), 200],
  ['pod edit', (req: NextRequest) => pod.PATCH(req, props), 200],
  ['pod delete', (req: NextRequest) => pod.DELETE(req, props), 200],
  ['pod link', (req: NextRequest) => links.POST(req, props), 201],
  ['pod unlink', (req: NextRequest) => links.DELETE(req, props), 200],
  ['pod member add', (req: NextRequest) => members.POST(req, props), 201],
  ['pod member edit', (req: NextRequest) => members.PATCH(req, props), 200],
  ['pod member delete', (req: NextRequest) => members.DELETE(req, props), 200],
  ['pod resolve', (req: NextRequest) => resolve.GET(req, props), 200],
  ['connector registrations list', (req: NextRequest) => connectorConnections.GET(req, props), 200],
  ['connector registrations create', (req: NextRequest) => connectorConnections.POST(req, props), 201],
  ['connector registrations rename', (req: NextRequest) => connectorConnections.PATCH(req, props), 200],
] as const;

describe.each(routes)('%s service gate', (_name, handler, status) => {
  function request() {
    return new NextRequest('https://kernel.test/connections/api', {
      method: 'POST',
      headers: { cookie: `imajin_session=test; x-acting-as=${ORG}` },
      body: JSON.stringify({ name: 'Pod', nickname: 'Friend', dids: ['did:imajin:other'], did: 'did:imajin:other', role: 'member', childPodId: 'child', label: 'Test' }),
    });
  }
  it.each([{ services: null }, { services: ['connections'] }])('allows unrestricted or listed-service maintainers ($services)', async ({ services }) => {
    allowedServices = services;
    expect((await handler(request())).status).toBe(status);
    expect(authSpy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ service: 'connections' }));
  });
  it.each([{ services: ['pay'] }, { services: [] }])('refuses unlisted/empty service access ($services) before data access', async ({ services }) => {
    allowedServices = services;
    const response = await handler(request());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Not authorized to act as this group' });
    for (const query of Object.values(db)) expect(query).not.toHaveBeenCalled();
    for (const operation of Object.values(registrations)) expect(operation).not.toHaveBeenCalled();
    expect(resolveMembers).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
});
