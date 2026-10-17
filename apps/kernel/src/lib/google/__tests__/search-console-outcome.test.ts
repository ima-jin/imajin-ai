import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Grant = {
  channel: string; did: string; appDid: string; slot: string; status: string; scopes: string[];
};
type Predicate = { column?: string; value?: unknown; predicates?: Predicate[]; members?: unknown[] };
const h = vi.hoisted(() => {
  const grants: Grant[] = [];
  const vault = new Map<string, string>();
  const identities = { id: 'identityId', metadata: 'metadata' };
  const matches = (row: Grant, predicate: Predicate): boolean => {
    if (predicate.predicates) return predicate.predicates.every((entry) => matches(row, entry));
    const actual = row[predicate.column as keyof Grant];
    return predicate.members ? predicate.members.includes(actual) : actual === predicate.value;
  };
  const where = vi.fn(async (predicate: Predicate) => grants.filter((row) => matches(row, predicate)));
  const seal = vi.fn(async (field: string, value: string) => { vault.set(field, value); });
  const load = vi.fn(async (field: string) => vault.get(field));
  return {
    grants, vault, where, seal, load, identities, registration: vi.fn(), sign: vi.fn(), audit: vi.fn(),
    db: { select: () => ({ from: (table: unknown) => table === identities
      ? { where: () => ({ limit: async () => [{ metadata: {} }] }) }
      : { where } }) },
    channelLinks: {
      channel: 'channel', did: 'did', appDid: 'appDid', slot: 'slot', status: 'status', scopes: 'scopes',
    },
  };
});
vi.mock('drizzle-orm', () => ({
  eq: (column: string, value: unknown) => ({ column, value }),
  and: (...predicates: Predicate[]) => ({ predicates }),
  inArray: (column: string, members: unknown[]) => ({ column, members }),
  like: vi.fn(), ne: vi.fn(), sql: vi.fn(),
}));
vi.mock('@/src/db', () => ({
  db: h.db, identities: h.identities, channelLinks: h.channelLinks, googleWorkspaceState: {}, assets: {}, consentGrants: {},
}));
vi.mock('@/src/lib/vault', () => ({ sealAndStoreV2: h.seal, loadAndUnseal: h.load }));
vi.mock('../../kernel/connector-registry-store', () => ({
  recordConnectorRegistration: h.registration,
  revokeConnectorRegistration: vi.fn(),
  syncConnectorRegistrationScopes: vi.fn(),
  listConnectorRegistrations: async (owner: string) => owner === 'did:imajin:organization'
    ? [{ provider: 'google', slot: 'marketing', label: 'Marketing' }, { provider: 'google', slot: 'other', label: 'Other' }] : [],
}));
// Keep the real manifest scope reader; unrelated publishing imports are not exercised.
vi.mock('../../media/create-asset', () => ({ createAsset: vi.fn() }));
vi.mock('../../media/update-asset', () => ({ updateAssetContent: vi.fn() }));
vi.mock('../../media/folders', () => ({ addAssetToGrantsFolder: vi.fn() }));
vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
}));
// Run the real bus chain and attestation reactor; only persistence/signing IO is mocked.
vi.mock('@imajin/db', () => ({ getClient: () => async () => [] }));
vi.mock('@imajin/auth', () => ({ emitAttestation: h.sign }));
vi.mock('../../../../../../packages/bus/src/subscriptions', () => ({
  deliverToSubscribers: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../../../../packages/bus/src/registry', async () => {
  const { attestationReactor } = await import('../../../../../../packages/bus/src/reactors/attestation');
  return { getReactor: (type: string) => type === 'attestation' ? attestationReactor : h.audit };
});
vi.mock('@imajin/bus', async () => ({
  publish: (await import('../../../../../../packages/bus/src/publish')).publish,
}));
vi.mock('../../mcp/tools', async () => {
  const { searchConsoleTools } = await import('../../mcp/tools/google-search-console');
  const { withToolConnection } = await import('../../mcp/connection-selector');
  const tools = searchConsoleTools.map(withToolConnection);
  return { ALL_TOOLS: tools, toolByName: (name: string) => tools.find((tool) => tool.name === name) };
});

import { storeConfig, buildAuthorizeUrl, exchangeCodeAndStore, GOOGLE_CONNECTOR_DID } from '../connector';
import { withConnectorConnection } from '../../kernel/connector-connection-context';
import { handleMcpRpc } from '../../mcp/server';
import { SEARCH_CONSOLE_SCOPE } from '../search-console';

const ORG = 'did:imajin:organization';
const APP = 'did:imajin:reporting-app';
const SLOT = 'marketing';
const PROVIDER_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const SITE = 'sc-domain:verified.example.com';
const rows = [{ keys: ['2026-10-01'], clicks: 12, impressions: 120, ctr: 0.1, position: 2.5 }];
const config = {
  clientId: 'mock-client-id', clientSecret: 'mock-client-secret',
  redirectUri: 'https://kernel.example.com/google/api/callback',
};

beforeEach(() => {
  vi.clearAllMocks();
  h.vault.clear();
  // This is the persisted scope-manifest projection, read by the real scope reader.
  h.grants.splice(0, h.grants.length,
    { channel: 'google', did: ORG, appDid: GOOGLE_CONNECTOR_DID, slot: SLOT,
      status: 'active', scopes: [SEARCH_CONSOLE_SCOPE] },
    { channel: 'mcp', did: ORG, appDid: APP, slot: 'primary',
      status: 'active', scopes: [SEARCH_CONSOLE_SCOPE] },
  );
  h.sign.mockResolvedValue({ attestationId: 'att_search_console_read' });
  h.audit.mockResolvedValue(undefined);
  vi.stubEnv('GOOGLE_BUSINESS_PROFILE_ENABLED', 'false');
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
    if (url === 'https://oauth2.googleapis.com/token') {
      return new Response(JSON.stringify({
        access_token: 'mock-org-marketing-access', refresh_token: 'mock-org-marketing-refresh',
        expires_in: 3600, scope: PROVIDER_SCOPE,
      }));
    }
    if (url === `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(SITE)}/searchAnalytics/query`) {
      return new Response(JSON.stringify({ rows, responseAggregationType: 'byProperty' }));
    }
    throw new Error(`Unexpected mocked provider request: ${String(url)}`);
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

async function connectSelectedOrganization() {
  return withConnectorConnection('google', ORG, SLOT, async () => {
    await storeConfig(ORG, config);
    const authorizeUrl = await buildAuthorizeUrl(ORG, 'mock-state');
    await exchangeCodeAndStore(ORG, 'mock-code');
    return new URL(authorizeUrl);
  });
}
function query(connection = 'Marketing', appDid = APP, scopes = [SEARCH_CONSOLE_SCOPE]) {
  return handleMcpRpc({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: {
      name: 'google_search_console_query_analytics',
      arguments: { connection, siteUrl: SITE, startDate: '2026-10-01', endDate: '2026-10-01', dimensions: ['date'] },
    },
  }, { did: ORG, appDid, scopes: new Set(scopes) });
}

describe('Search Console selected organization outcome (#2894)', () => {
  it('selects one manifest scope, seals org-slot OAuth credentials, queries analytics via app grant and signs provenance', async () => {
    const authorize = await connectSelectedOrganization();
    expect(authorize.origin + authorize.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(authorize.searchParams.get('scope')).toBe(PROVIDER_SCOPE);
    expect(authorize.searchParams.get('include_granted_scopes')).toBe('true');
    expect(h.seal).toHaveBeenCalledWith(`google-config:${ORG}:${SLOT}`, JSON.stringify(config));
    expect(JSON.parse(h.vault.get(`google-oauth:${ORG}:${SLOT}`)!)).toMatchObject({
      accessToken: 'mock-org-marketing-access', refreshToken: 'mock-org-marketing-refresh', scope: PROVIDER_SCOPE,
    });
    expect(h.vault.has(`google-oauth:${ORG}`)).toBe(false);
    expect(h.registration).toHaveBeenCalledWith({
      ownerDid: ORG, provider: 'google', slot: SLOT, sealedKeyField: `google-oauth:${ORG}:${SLOT}`,
    });
    const [tokenUrl, tokenRequest] = vi.mocked(fetch).mock.calls[0];
    expect(tokenUrl).toBe('https://oauth2.googleapis.com/token');
    expect(new URLSearchParams(tokenRequest?.body as string).get('grant_type')).toBe('authorization_code');

    const response = await query();
    expect(response).toMatchObject({
      result: { isError: false, content: [{ text: JSON.stringify({ rows, responseAggregationType: 'byProperty' }, null, 2) }] },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    const [, request] = vi.mocked(fetch).mock.calls[1];
    expect(request?.headers).toEqual({
      Authorization: 'Bearer mock-org-marketing-access', 'Content-Type': 'application/json',
    });
    expect(JSON.parse(request?.body as string)).toMatchObject({ rowLimit: 1000, startRow: 0, dimensions: ['date'] });
    const provenance = {
      ownerDid: ORG, onBehalfOf: ORG, slot: SLOT,
      operation: 'search-console.searchAnalytics.query', context_id: ORG, context_type: 'google',
    };
    expect(h.sign).toHaveBeenCalledWith(expect.objectContaining({
      issuer_did: ORG, subject_did: ORG, type: 'google.data.read', payload: provenance,
    }));
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({
      issuer: ORG, subject: ORG, payload: { ...provenance, attestationId: 'att_search_console_read' },
    }), {});
    expect(JSON.stringify(h.sign.mock.calls)).not.toContain(SITE);
    expect(JSON.stringify(h.sign.mock.calls)).not.toContain('impressions');
  });

  it('denies missing provider-consented scope even with active local and app grants', async () => {
    await connectSelectedOrganization();
    const field = `google-oauth:${ORG}:${SLOT}`;
    const tokens = JSON.parse(h.vault.get(field)!);
    h.vault.set(field, JSON.stringify({ ...tokens, scope: 'https://www.googleapis.com/auth/gmail.readonly' }));
    vi.mocked(fetch).mockClear();
    const response = await query();
    expect(response).toMatchObject({ result: {
      isError: true, content: [{ text: expect.stringContaining('google_insufficient_scope') }],
    } });
    expect(fetch).not.toHaveBeenCalled();
    expect(h.sign).not.toHaveBeenCalled();
  });

  it('does not borrow the configured organization slot when another named connection is selected', async () => {
    await connectSelectedOrganization();
    h.load.mockClear();
    vi.mocked(fetch).mockClear();
    const response = await query('Other');
    expect(response).toMatchObject({ result: {
      isError: true, content: [{ text: expect.stringContaining('google_no_grant') }],
    } });
    expect(h.load).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(h.sign).not.toHaveBeenCalled();
  });

  it('revoking the app grant stops reads even while its token and Google consent remain valid', async () => {
    await connectSelectedOrganization();
    h.grants[1].status = 'revoked';
    h.load.mockClear();
    vi.mocked(fetch).mockClear();
    const response = await query();
    expect(response).toMatchObject({ result: {
      isError: true, content: [{ text: expect.stringContaining('mcp_no_grant') }],
    } });
    expect(h.load).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(h.sign).not.toHaveBeenCalled();
  });

  it('another app cannot inherit the reporting app grant', async () => {
    await connectSelectedOrganization();
    vi.mocked(fetch).mockClear();
    const response = await query('Marketing', 'did:imajin:another-app');
    expect(response).toMatchObject({ result: {
      isError: true, content: [{ text: expect.stringContaining('mcp_no_grant') }],
    } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('the token scope gate still applies when the manifest grant is live', async () => {
    const response = await query('Marketing', APP, []);
    expect(response).toMatchObject({ result: {
      isError: true, content: [{ text: expect.stringContaining('scope_token_stale') }],
    } });
    expect(h.load).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
