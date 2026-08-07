/**
 * Tests for the discovery MCP tools (#1636, re-homed onto `mcp` by #1679).
 *
 * The spec reader, the connector-status query, and the MCP grant gate are mocked
 * — each has its own tests. What matters here is that every tool is gated on
 * `discovery:read` at BOTH gates, that the manifest gate runs before any data is
 * read, that reads are pinned to `ctx.did`, and that nothing credential-shaped
 * leaks into the payload.
 *
 * The scope-vocabulary and connector-registry projections are deliberately left
 * REAL: they are client-safe and dependency-free, and mocking them would turn the
 * assertions about what the catalogue reports into assertions about the mock.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { McpContent, McpToolContext } from '../types';

// ─── Mocks ─────────────────────────────────────────────────────────────────

vi.mock('../mcp-grant', () => ({
  requireDiscoveryGrant: vi.fn(),
  MCP_DISCOVERY_SCOPE: 'discovery:read',
}));

vi.mock('@/src/lib/kernel/api-specs', () => ({
  listApiSpecs: vi.fn(),
  readApiSpec: vi.fn(),
  SPEC_MAX_CHARS: 400_000,
}));

vi.mock('@/src/lib/kernel/connector-status', () => ({
  readConnectorConnectionStatus: vi.fn(),
}));

// Deliberately NOT importing `../tools` (the registry): it eagerly pulls in every
// other tool module and, through them, the DB client, which needs a live
// DATABASE_URL. Registry membership is enforced by the typechecked import in
// tools/index.ts; behaviour is what is worth testing here.
import { discoveryTools } from '../tools/discovery';
import { requireDiscoveryGrant } from '../mcp-grant';
import { listApiSpecs, readApiSpec } from '@/src/lib/kernel/api-specs';
import { readConnectorConnectionStatus } from '@/src/lib/kernel/connector-status';
import { MCP_SCOPES } from '../oauth-config';

// ─── Helpers ───────────────────────────────────────────────────────────────

const ctx: McpToolContext = {
  did: 'did:imajin:veteze',
  appDid: 'did:imajin:mcp-connector',
  scopes: new Set(['discovery:read']),
};

const AUTH_SUMMARY = {
  service: 'auth',
  endpoint: '/auth/api/spec',
  label: 'Identity',
  title: 'imajin auth',
  version: '1.0.0',
  paths: ['/auth/api/session'],
};

function tool(name: string) {
  const t = discoveryTools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
}

async function call(name: string, args: Record<string, unknown> = {}) {
  return (await tool(name).handler(args, ctx)) as McpContent[];
}

function parseResult(content: McpContent[]) {
  return JSON.parse(content[0].text);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireDiscoveryGrant).mockResolvedValue(undefined);
  vi.mocked(listApiSpecs).mockReturnValue([AUTH_SUMMARY]);
  vi.mocked(readApiSpec).mockReturnValue({
    service: 'auth',
    endpoint: '/auth/api/spec',
    content: 'openapi: "3.1.0"\n',
    contentType: 'text/yaml',
    truncated: false,
  });
  vi.mocked(readConnectorConnectionStatus).mockResolvedValue([
    { id: 'mcp', connected: true, scopes: ['discovery:read'] },
    { id: 'warp', connected: false, scopes: [] },
  ]);
});

// ─── Registry ──────────────────────────────────────────────────────────────

describe('registration', () => {
  it('exports the spec, vocabulary, and connector-status tools', () => {
    expect(discoveryTools.map((t) => t.name)).toEqual([
      'imajin_list_api_specs',
      'imajin_get_api_spec',
      'imajin_list_scopes',
      'imajin_get_scope_manifest',
    ]);
  });

  it('gates every tool on discovery:read', () => {
    for (const t of discoveryTools) {
      expect(t.requiredScope, t.name).toBe('discovery:read');
    }
  });

  /**
   * No tool here may be gated on `warp:dispatch`: reading what the system exposes
   * must not require, or imply, the ability to spend money on a cloud agent.
   */
  it('gates nothing here on warp:dispatch', () => {
    expect(discoveryTools.map((t) => t.requiredScope)).not.toContain('warp:dispatch');
  });

  it('rejects unknown arguments on every tool schema (fail-closed)', () => {
    for (const t of discoveryTools) {
      expect(t.inputSchema.additionalProperties, t.name).toBe(false);
    }
  });

  it('documents every advertised argument so a caller need not guess', () => {
    for (const t of discoveryTools) {
      const properties = t.inputSchema.properties as Record<string, { description?: string }>;
      for (const [name, schema] of Object.entries(properties)) {
        expect(schema.description, `${t.name}.${name}`).toBeTruthy();
      }
    }
  });

  /**
   * The surface is read-only by construction: there is no `discovery:write` and
   * no tool name that implies mutation. Writes land through git and a PR.
   */
  it('advertises no mutating tool', () => {
    for (const t of discoveryTools) {
      expect(t.name, t.name).toMatch(/^imajin_(list|get)_/);
    }
  });
});

// ─── The manifest gate ─────────────────────────────────────────────────────

describe('scope-manifest gate', () => {
  it.each([
    ['imajin_list_api_specs', {}],
    ['imajin_get_api_spec', { service: 'auth' }],
    ['imajin_list_scopes', {}],
    ['imajin_get_scope_manifest', {}],
  ])('checks the caller DID grant before %s serves anything', async (name, args) => {
    await call(name, args);
    expect(requireDiscoveryGrant).toHaveBeenCalledWith(ctx.did);
  });

  it.each([
    ['imajin_list_api_specs', {}],
    ['imajin_get_api_spec', { service: 'auth' }],
    ['imajin_list_scopes', {}],
    ['imajin_get_scope_manifest', {}],
  ])('propagates a revoked grant out of %s rather than serving a partial read', async (name, args) => {
    vi.mocked(requireDiscoveryGrant).mockRejectedValue(new Error('mcp_no_grant: nope'));

    await expect(tool(name).handler(args, ctx)).rejects.toThrow(/mcp_no_grant/);
    expect(listApiSpecs).not.toHaveBeenCalled();
    expect(readApiSpec).not.toHaveBeenCalled();
    expect(readConnectorConnectionStatus).not.toHaveBeenCalled();
  });
});

// ─── imajin_list_api_specs ─────────────────────────────────────────────────

describe('imajin_list_api_specs', () => {
  it('returns the catalogue with a count', async () => {
    expect(parseResult(await call('imajin_list_api_specs'))).toEqual({
      count: 1,
      specs: [AUTH_SUMMARY],
    });
  });

  it('reports an empty catalogue rather than failing', async () => {
    vi.mocked(listApiSpecs).mockReturnValueOnce([]);
    expect(parseResult(await call('imajin_list_api_specs'))).toEqual({ count: 0, specs: [] });
  });
});

// ─── imajin_get_api_spec ───────────────────────────────────────────────────

describe('imajin_get_api_spec', () => {
  it('returns the spec source with its endpoint and truncation flag', async () => {
    const out = parseResult(await call('imajin_get_api_spec', { service: 'auth' }));

    expect(readApiSpec).toHaveBeenCalledWith('auth', {});
    expect(out).toEqual({
      service: 'auth',
      endpoint: '/auth/api/spec',
      content: 'openapi: "3.1.0"\n',
      contentType: 'text/yaml',
      truncated: false,
    });
  });

  it('passes max_chars through as the cap', async () => {
    await call('imajin_get_api_spec', { service: 'auth', max_chars: 500 });
    expect(readApiSpec).toHaveBeenCalledWith('auth', { maxChars: 500 });
  });

  it('ignores a non-numeric max_chars rather than coercing it', async () => {
    await call('imajin_get_api_spec', { service: 'auth', max_chars: 'lots' });
    expect(readApiSpec).toHaveBeenCalledWith('auth', {});
  });

  it('throws without a read when service is missing', async () => {
    await expect(tool('imajin_get_api_spec').handler({}, ctx)).rejects.toThrow(
      /service is required/,
    );
    expect(readApiSpec).not.toHaveBeenCalled();
    expect(requireDiscoveryGrant).not.toHaveBeenCalled();
  });

  /**
   * Named rather than empty: an agent that mistyped a service should learn that,
   * not conclude the API has no spec and go read source instead.
   */
  it('names an unknown service instead of returning nothing', async () => {
    vi.mocked(readApiSpec).mockReturnValueOnce(null);
    await expect(
      tool('imajin_get_api_spec').handler({ service: 'nope' }, ctx),
    ).rejects.toThrow(/unknown_spec.*nope/);
  });
});

// ─── imajin_list_scopes ────────────────────────────────────────────────────

describe('imajin_list_scopes', () => {
  it('reports the whole vocabulary with the MCP ceiling and the token scopes', async () => {
    const out = parseResult(await call('imajin_list_scopes'));

    expect(out.count).toBe(out.scopes.length);
    expect(out.mcpCeiling).toEqual([...MCP_SCOPES]);
    expect(out.tokenScopes).toEqual(['discovery:read']);
  });

  it('describes discovery:read itself, so the surface is self-documenting', async () => {
    const out = parseResult(await call('imajin_list_scopes'));

    expect(out.scopes).toEqual(
      expect.arrayContaining([
        {
          scope: 'discovery:read',
          label: 'Read Imajin API specs, the scope vocabulary, and your connector status',
          connector: 'mcp',
          releaseClass: 'silent',
          mcpToken: true,
        },
      ]),
    );
  });

  it('marks platform scopes with a null connector and no release class', async () => {
    const out = parseResult(await call('imajin_list_scopes'));
    const profile = out.scopes.find((s: { scope: string }) => s.scope === 'profile:read');

    expect(profile).toMatchObject({ connector: null, releaseClass: null, mcpToken: false });
  });
});

// ─── imajin_get_scope_manifest ─────────────────────────────────────────────

describe('imajin_get_scope_manifest', () => {
  it('reports the caller DID status, never another DID', async () => {
    const out = parseResult(await call('imajin_get_scope_manifest'));

    expect(readConnectorConnectionStatus).toHaveBeenCalledWith(ctx.did);
    expect(readConnectorConnectionStatus).toHaveBeenCalledTimes(1);
    expect(out.did).toBe(ctx.did);
    expect(out.tokenScopes).toEqual(['discovery:read']);
    expect(out.status).toEqual([
      { id: 'mcp', connected: true, scopes: ['discovery:read'] },
      { id: 'warp', connected: false, scopes: [] },
    ]);
  });

  it('names each connector, its DID, and what it can grant', async () => {
    const out = parseResult(await call('imajin_get_scope_manifest'));
    const warp = out.connectors.find((c: { id: string }) => c.id === 'warp');

    expect(warp).toMatchObject({
      id: 'warp',
      channel: 'warp',
      connectorDid: 'did:imajin:warp-connector',
      statusEndpoint: '/warp/api/scope-manifest',
      ingestionPattern: 'static-secret',
    });
    expect(warp.grantableScopes.map((s: { name: string }) => s.name)).toEqual(['warp:dispatch']);
  });

  /**
   * #1679: the agent reading this payload is usually looking for where to get
   * `discovery:read`. It must find the native connector — pointing it at the
   * Warp card is what sent people off to seal a key they never needed.
   */
  it('points discovery:read at the credential-free MCP connector', async () => {
    const out = parseResult(await call('imajin_get_scope_manifest'));
    const mcp = out.connectors.find((c: { id: string }) => c.id === 'mcp');

    expect(mcp).toMatchObject({
      ingestionPattern: 'native',
      statusEndpoint: '/mcp/api/scope-manifest',
    });
    expect(mcp.grantableScopes.map((s: { name: string }) => s.name)).toContain('discovery:read');
  });

  /**
   * The registry carries credential-paste copy and route URLs. Surfacing those to
   * an agent invites it to try to seal a credential it should never hold, so the
   * projection drops them.
   */
  it('omits credential copy and credential routes from the payload', async () => {
    const out = parseResult(await call('imajin_get_scope_manifest'));
    const serialised = JSON.stringify(out);

    for (const connector of out.connectors) {
      expect(connector).not.toHaveProperty('credentialUi');
      expect(connector).not.toHaveProperty('tokenRoute');
      expect(connector).not.toHaveProperty('connectRoute');
      expect(connector).not.toHaveProperty('configureRoute');
      expect(connector).not.toHaveProperty('disconnectRoute');
    }
    expect(serialised).not.toContain('Warp Agent Key');
    expect(serialised).not.toContain('/warp/api/seal');
  });
});
