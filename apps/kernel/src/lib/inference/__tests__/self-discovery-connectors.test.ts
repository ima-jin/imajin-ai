import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

const h = vi.hoisted(() => ({
  registrations: vi.fn(), registration: vi.fn(), access: vi.fn(), principal: vi.fn(),
  http: vi.fn(), grant: vi.fn(), credential: vi.fn(), mcp: vi.fn(), app: vi.fn(),
}));
vi.mock('@/src/db', () => ({ db: {} }));
vi.mock('@/src/lib/kernel/connector-registry-store', () => ({
  listConnectorRegistrations: h.registrations, readConnectorRegistration: h.registration,
}));
vi.mock('@/src/lib/kernel/external-mcp-authority', () => ({ authorizeExternalMcpAccess: h.access }));
vi.mock('@/src/lib/kernel/connection-principal', () => ({ resolveConnectionPrincipal: h.principal }));
vi.mock('@/src/lib/kernel/member-connection-gate', () => ({
  POSTMAN_CONNECTION: { provider: 'external-mcp-postman', scope: 'connectors:mcp:read' },
  requireConnectionApp: h.app,
}));
vi.mock('@/src/lib/mcp/mcp-grant', () => ({ resolveActiveMcpGrant: h.mcp }));
vi.mock('../http-connector-authority', () => ({
  httpConnectorAuthority: h.http, httpCredentialAuthorized: h.credential,
}));
vi.mock('../brain', () => ({
  listBrainConnectors: () => ['anthropic', 'openai', 'gemini', 'xai', 'zai', 'moonshot', 'local', 'openrouter'],
}));
import { ExternalMcpError } from '@/src/lib/kernel/external-mcp-policy';
import { listDiscoveryConnectorMetadata, discoveryExternalConnection } from '../self-discovery-connectors';
import type { InferenceAuthContext } from '../auth';
import { upstreamBinding, upstreamProvider, UPSTREAM_READ_SCOPE, UPSTREAM_WRITE_SCOPE } from '@/src/lib/kernel/app-upstream-policy';

const actor = 'did:imajin:agent';
const org = 'did:imajin:org';
const target = { provider: 'external-mcp-postman', scope: 'connectors:mcp:read' };
const context: InferenceAuthContext = { ownerDid: actor, caller: { actorDid: actor } };

beforeEach(() => {
  vi.resetAllMocks();
  h.registrations.mockResolvedValue([]);
  h.principal.mockResolvedValue({ ownerDid: actor });
  h.access.mockRejectedValue(new ExternalMcpError(403, 'Private exception', 'connection_not_loaded'));
  h.http.mockResolvedValue({ grant: h.grant, fields: () => [] });
  h.grant.mockResolvedValue(false);
  h.credential.mockResolvedValue(false);
  h.mcp.mockResolvedValue(false);
});

describe('read-only connector authority projection', () => {
  it('distinguishes configured from usable and never spreads registry fields', async () => {
    const privateValue = randomUUID();
    h.registrations.mockResolvedValue([
      { provider: 'warp', status: 'active', sealedKeyField: privateValue },
      { provider: 'future-family', status: 'active', sealedKeyField: privateValue },
      { provider: 'org-held-warp', status: 'active' }, { provider: 'anthropic-billing', status: 'active' },
    ]);
    const rows = await listDiscoveryConnectorMetadata(context);
    expect(h.registrations).toHaveBeenCalledWith(actor);
    expect(h.registration).not.toHaveBeenCalled();
    expect(rows.find(row => row.provider === 'warp')).toMatchObject({
      family: 'http', configured: true, grantStatus: 'denied', usable: false,
      fix: { href: '/auth/connectors/warp', actingDid: actor },
    });
    expect(rows.find(row => row.provider === 'future-family')).toMatchObject({
      family: 'http', configured: true, grantStatus: 'not-evaluated', usable: null,
    });
    expect(rows.some(row => ['org-held-warp', 'anthropic-billing', 'anthropic', 'openai'].includes(row.provider))).toBe(false);
    expect(JSON.stringify(rows)).not.toContain(privateValue);
    expect(JSON.stringify(rows)).not.toContain('Private exception');
  });

  it('does not turn inference scope into tool authority or inspect private principal configuration', async () => {
    const rows = await listDiscoveryConnectorMetadata({
      ownerDid: org, appDid: 'did:imajin:app', caller: { actorDid: actor, actingAs: org },
      toolAuth: { scopes: ['infer:completions'], serviceToken: false },
    });
    expect(rows.every(row => row.usable === false)).toBe(true);
    expect(h.access).not.toHaveBeenCalled();
    expect(h.http).not.toHaveBeenCalled();
    expect(h.principal).not.toHaveBeenCalled();
    expect(h.registration).not.toHaveBeenCalled();
    expect(h.registrations).toHaveBeenCalledTimes(1);
    expect(h.registrations).toHaveBeenCalledWith(actor);
  });

  it('fails closed when an app context has no verified token ceiling', async () => {
    const rows = await listDiscoveryConnectorMetadata({ ...context, appDid: 'did:imajin:app' });
    expect(rows.every(row => row.usable === false)).toBe(true);
    expect(h.access).not.toHaveBeenCalled();
  });

  it('uses the HTTP call predicate and current custody metadata instead of configuration as authority', async () => {
    h.grant.mockResolvedValue(true);
    h.credential.mockResolvedValue(true);
    const rows = await listDiscoveryConnectorMetadata(context);
    expect(rows.find(row => row.provider === 'typesafe')).toMatchObject({
      authority: 'own-key', grantStatus: 'granted', usable: true,
      authorizedScopes: ['typesafe:decide'], credentialStatus: 'not-probed',
    });
    expect(h.grant).toHaveBeenCalledWith(actor, 'typesafe:decide');
    h.credential.mockResolvedValue(false);
    const revoked = await listDiscoveryConnectorMetadata(context);
    expect(revoked.find(row => row.provider === 'typesafe')).toMatchObject({
      usable: false, reason: { code: 'credential_unavailable' },
    });
  });

  it('keeps HTTP token scopes narrower than manifest grants', async () => {
    h.grant.mockResolvedValue(true);
    h.credential.mockResolvedValue(true);
    const rows = await listDiscoveryConnectorMetadata({
      ...context, appDid: 'did:imajin:app', toolAuth: { scopes: ['discord:read'], serviceToken: false },
    });
    expect(rows.find(row => row.provider === 'discord')?.authorizedScopes).toEqual(['discord:read']);
    expect(h.grant).not.toHaveBeenCalledWith(actor, 'discord:post');
    expect(rows.find(row => row.provider === 'typesafe')?.usable).toBe(false);
  });

  it('projects native MCP grants without any credential check', async () => {
    h.mcp.mockImplementation(async (_did, scope) => scope === 'connections:read');
    const rows = await listDiscoveryConnectorMetadata(context);
    expect(rows.find(row => row.provider === 'mcp')).toMatchObject({
      usable: true, authority: 'own-key', authorizedScopes: ['connections:read'],
    });
    expect(h.credential).not.toHaveBeenCalled();
  });

  it.each([
    ['agent_not_assigned', '/auth/agents'], ['service_not_allowed', '/auth/agents'],
    ['org_membership_required', '/auth/members'],
    ['org_grant_required', '/auth/connectors#org-connector-external-mcp-postman-grants'],
    ['identity_inactive', '/auth/members'], ['connection_suspended', '/auth/members'],
  ] as const)('provides an existing fixing control for %s without exposing exception details', async (code, href) => {
    h.access.mockRejectedValue(new ExternalMcpError(403, randomUUID(), code));
    expect(await discoveryExternalConnection(context, target, 'mcp')).toMatchObject({
      usable: false, configurationStatus: 'not-disclosed', reason: { code }, fix: { href },
    });
  });

  it.each([
    [{ ownerDid: actor }, 'own-key', actor],
    [{ ownerDid: org, orgContext: { assignedAgentDid: actor } }, 'org-held', org],
    [{ ownerDid: org, orgContext: { memberDid: actor } }, 'member-grant', org],
    [{ ownerDid: 'did:imajin:human' }, 'delegated', 'did:imajin:human'],
  ] as const)('uses the resolved principal authority lane %#', async (principal, authority, ownerDid) => {
    h.principal.mockResolvedValue(principal);
    h.access.mockResolvedValue({ row: { ownerDid, sealedKeyField: randomUUID() }, custodyId: randomUUID() });
    const row = await discoveryExternalConnection(context, target, 'mcp');
    expect(row).toMatchObject({ authority, ownerDid, configured: true, usable: true });
    expect(row).not.toHaveProperty('sealedKeyField');
    expect(row).not.toHaveProperty('custodyId');
  });

  it('keeps configured true when custody is revoked and refuses to invent usability', async () => {
    h.access.mockResolvedValue({ row: { ownerDid: actor }, custodyId: null });
    expect(await discoveryExternalConnection(context, target, 'mcp')).toMatchObject({
      configured: true, usable: false, configurationStatus: 'configured',
      reason: { code: 'credential_unavailable' },
    });
  });

  it('uses Warp assigned-personal ownership only after the real assignment and grant checks pass', async () => {
    h.principal.mockResolvedValue({ ownerDid: 'did:imajin:human' });
    h.grant.mockResolvedValue(true);
    h.credential.mockResolvedValue(true);
    h.registration.mockResolvedValue({ status: 'active' });
    const rows = await listDiscoveryConnectorMetadata({
      ownerDid: 'did:imajin:human', caller: { actorDid: actor, actingFor: 'did:imajin:human' },
    });
    expect(rows.find(row => row.provider === 'warp')).toMatchObject({
      ownerDid: 'did:imajin:human', authority: 'delegated', configured: true, usable: true,
    });
    expect(h.registration).not.toHaveBeenCalled();
  });

  it('projects the org Warp call gate instead of the personal scope predicate', async () => {
    h.principal.mockResolvedValue({ ownerDid: org, orgContext: { assignedAgentDid: actor } });
    h.access.mockResolvedValue({ row: { ownerDid: org }, custodyId: randomUUID() });
    const rows = await listDiscoveryConnectorMetadata({ ownerDid: org, caller: { actorDid: actor, actingAs: org } });
    expect(rows.find(row => row.provider === 'warp')).toMatchObject({ ownerDid: org, authority: 'org-held', usable: true });
    expect(h.grant).not.toHaveBeenCalledWith(org, 'warp:dispatch');
  });

  it('keeps denied assignment metadata hidden and supplies an existing fixing control', async () => {
    h.principal.mockRejectedValue(new ExternalMcpError(403, randomUUID(), 'service_not_allowed'));
    const rows = await listDiscoveryConnectorMetadata({
      ownerDid: org, caller: { actorDid: actor, actingAs: org },
    });
    expect(rows.find(row => row.provider === 'warp')).toMatchObject({
      ownerDid: org, usable: false, configurationStatus: 'not-disclosed', fix: { href: '/auth/agents', actingDid: org },
    });
    expect(h.access).toHaveBeenCalledTimes(1);
  });

  it('retains unknown HTTP adapters as unverified, not a fictional authorization', async () => {
    h.http.mockResolvedValue(undefined);
    const rows = await listDiscoveryConnectorMetadata(context);
    expect(rows.find(row => row.provider === 'typesafe')).toMatchObject({
      usable: null, authority: null, grantStatus: 'not-evaluated', fix: { href: '/auth/connectors' },
    });
  });

  it.each(['read', 'write', 'both', 'revoked', 'changed-binding', 'no-declared-method'])(
    'app-upstream projection uses the declared binding and %s scope gate', async mode => {
      const appDid = 'did:imajin:service-app';
      const upstream = {
        id: 'catalog', origin: 'https://api.example.test', credentialHeader: 'Authorization' as const,
        credentialPrefix: 'Bearer ' as const, paths: [{ path: '/items', methods: ['GET', 'POST'] as ('GET' | 'POST')[] }],
      };
      if (mode === 'no-declared-method') upstream.paths[0].methods = ['POST'];
      const scopes = mode === 'write' ? [UPSTREAM_WRITE_SCOPE]
        : mode === 'both' ? [UPSTREAM_READ_SCOPE, UPSTREAM_WRITE_SCOPE] : [UPSTREAM_READ_SCOPE];
      h.app.mockResolvedValue({ upstreams: [upstream] });
      const binding = upstreamBinding(appDid, upstream);
      h.access.mockImplementation(async (_db, _caller, target) => {
        if (target.binding !== binding || mode === 'changed-binding' || mode === 'revoked') {
          throw new ExternalMcpError(403, randomUUID(), 'connection_not_loaded');
        }
        return { row: { ownerDid: actor, sealedKeyField: randomUUID() }, custodyId: randomUUID() };
      });
      const rows = await listDiscoveryConnectorMetadata({
        ...context, appDid, toolAuth: { scopes, serviceToken: true },
      });
      const upstreamRow = rows.find(row => row.provider === upstreamProvider(appDid, upstream.id));
      expect(upstreamRow?.usable).toBe(!['revoked', 'changed-binding', 'no-declared-method'].includes(mode));
      expect(upstreamRow?.authorizedScopes).toEqual(upstreamRow?.usable ? scopes : []);
      expect(h.app).toHaveBeenCalledWith(expect.anything(), appDid, UPSTREAM_READ_SCOPE, true);
      expect(JSON.stringify(rows)).not.toContain(binding);
      expect(JSON.stringify(rows)).not.toContain(upstream.origin);
    },
  );

  it('does not expose an unapproved app catalogue or turn a live denial into endpoint failure', async () => {
    h.app.mockRejectedValue(new ExternalMcpError(403, randomUUID()));
    const rows = await listDiscoveryConnectorMetadata({
      ...context, appDid: 'did:imajin:app', toolAuth: { scopes: [UPSTREAM_READ_SCOPE], serviceToken: true },
    });
    expect(rows.find(row => row.provider === 'app-upstream')).toMatchObject({
      usable: false, grantStatus: 'denied', fix: { href: '/auth/connectors' },
    });
    expect(rows.some(row => row.provider.startsWith('app-upstream:'))).toBe(false);
  });

  it('propagates unexpected HTTP and app catalogue storage failures', async () => {
    h.http.mockRejectedValueOnce(new Error('HTTP store unavailable'));
    await expect(listDiscoveryConnectorMetadata(context)).rejects.toThrow('HTTP store unavailable');
    h.app.mockRejectedValue(new Error('App store unavailable'));
    await expect(listDiscoveryConnectorMetadata({
      ...context, appDid: 'did:imajin:app', toolAuth: { scopes: [UPSTREAM_READ_SCOPE], serviceToken: true },
    })).rejects.toThrow('App store unavailable');
  });

  it('fails closed on storage errors, not an invented empty state', async () => {
    h.registrations.mockRejectedValue(new Error('Unavailable'));
    await expect(listDiscoveryConnectorMetadata(context)).rejects.toThrow('Unavailable');
    h.access.mockRejectedValue(new Error('Unavailable'));
    await expect(discoveryExternalConnection(context, target, 'mcp')).rejects.toThrow('Unavailable');
  });
});
