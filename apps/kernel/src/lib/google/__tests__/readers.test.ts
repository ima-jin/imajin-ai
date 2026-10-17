import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { credential, publishMock, appGrant, approval, registrations } = vi.hoisted(() => ({
  credential: vi.fn(), publishMock: vi.fn(), appGrant: vi.fn(),
  approval: vi.fn(), registrations: vi.fn(),
}));
vi.mock('../connector', () => ({
  requireGrantAndToken: credential,
  googleApiFetch: async (options: { baseUrl: string; path: string; token: string; method?: string; body?: unknown; apiLabel: string }) => {
    const response = await fetch(`${options.baseUrl}${options.path}`, {
      method: options.method ?? 'GET',
      headers: { Authorization: `Bearer ${options.token}`, 'Content-Type': 'application/json' },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    if (!response.ok) throw new Error(`${options.apiLabel} API error ${response.status}`);
    return response.json();
  },
}));
vi.mock('@imajin/bus', () => ({ publish: publishMock }));
vi.mock('../setup', () => ({ requireBusinessProfileApproval: approval }));
vi.mock('../../mcp/mcp-grant', () => ({
  requireMcpGrant: appGrant, resolveActiveMcpGrant: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../kernel/connector-registry-store', () => ({ listConnectorRegistrations: registrations }));
// Use only the new real tools while exercising the real dispatcher and selector.
vi.mock('../../mcp/tools', async () => {
  const { searchConsoleTools } = await import('../../mcp/tools/google-search-console');
  const { businessProfileTools } = await import('../../mcp/tools/google-business-profile');
  const { withToolConnection } = await import('../../mcp/connection-selector');
  const tools = [...searchConsoleTools, ...businessProfileTools].map(withToolConnection);
  return { ALL_TOOLS: tools, toolByName: (name: string) => tools.find((tool) => tool.name === name) };
});

import { listSites, querySearchAnalytics, inspectUrl, SEARCH_CONSOLE_SCOPE } from '../search-console';
import { listLocations, listReviews, BUSINESS_PROFILE_SCOPE } from '../business-profile';
import { isBusinessProfileEnabled } from '../features';
import { currentConnectionSlot, withConnectorConnection } from '../../kernel/connector-connection-context';
import { handleMcpRpc } from '../../mcp/server';
import { searchConsoleTools } from '../../mcp/tools/google-search-console';
import { businessProfileTools } from '../../mcp/tools/google-business-profile';

const OWNER = 'did:imajin:organization';
const APP = 'did:imajin:client-app';
const dates = { siteUrl: 'sc-domain:example.com', startDate: '2026-01-01', endDate: '2026-01-31' };
const business = { accountId: '123', locationId: '456' };
const allCalls = [
  () => listSites(OWNER),
  () => querySearchAnalytics(OWNER, dates),
  () => inspectUrl(OWNER, { siteUrl: dates.siteUrl, inspectionUrl: 'https://example.com/private' }),
  () => listLocations(OWNER, { accountId: business.accountId }),
  () => listReviews(OWNER, business),
];

beforeEach(() => {
  vi.resetAllMocks();
  credential.mockResolvedValue('mock-access-token');
  publishMock.mockResolvedValue({ attestationId: 'att_read' });
  appGrant.mockResolvedValue(undefined);
  approval.mockResolvedValue(undefined);
  registrations.mockResolvedValue([{ provider: 'google', slot: 'work', label: 'Company' }]);
  vi.stubEnv('GOOGLE_BUSINESS_PROFILE_ENABLED', 'true');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}')));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

function respond(data: unknown) {
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(data)));
}
function rpc(name: string, args: Record<string, unknown>, scopes: string[]) {
  return handleMcpRpc({
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args },
  }, { did: OWNER, appDid: APP, scopes: new Set(scopes) });
}

describe('Google typed readers', () => {
  it.each(allCalls.map((call, index) => ({ call, index })))('fails closed on connector grant denial ($index)', async ({ call }) => {
    credential.mockRejectedValue(new Error('google_no_grant'));
    await expect(call()).rejects.toThrow('google_no_grant');
    expect(fetch).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('lists Search Console properties and signs owner/slot provenance without property data', async () => {
    const sites = [{ siteUrl: 'https://private.example.com/', permissionLevel: 'siteOwner' }];
    respond({ siteEntry: sites });
    const result = await withConnectorConnection('google', OWNER, 'work', () => listSites(OWNER));
    expect(result).toEqual({ sites });
    expect(credential).toHaveBeenCalledWith(OWNER, SEARCH_CONSOLE_SCOPE);
    expect(fetch).toHaveBeenCalledWith('https://www.googleapis.com/webmasters/v3/sites', expect.anything());
    expect(publishMock).toHaveBeenCalledWith('google.data.read', {
      issuer: OWNER, subject: OWNER, scope: 'google',
      payload: { ownerDid: OWNER, onBehalfOf: OWNER, slot: 'work',
        operation: 'search-console.sites.list', context_id: OWNER, context_type: 'google' },
    });
    expect(JSON.stringify(publishMock.mock.calls)).not.toContain('private.example.com');
  });

  it('POSTs encoded analytics property and explicit bounded pagination', async () => {
    const rows = [{ keys: ['private query'], clicks: 1, impressions: 4, ctr: 0.25, position: 2 }];
    respond({ rows, responseAggregationType: 'byProperty' });
    expect(await querySearchAnalytics(OWNER, { ...dates, rowLimit: 25, startRow: 25, dimensions: ['query'] }))
      .toEqual({ rows, responseAggregationType: 'byProperty' });
    const [url, request] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query');
    expect(request?.method).toBe('POST');
    expect(JSON.parse(request?.body as string)).toEqual({
      startDate: dates.startDate, endDate: dates.endDate, rowLimit: 25, startRow: 25, dimensions: ['query'],
    });
    expect(JSON.stringify(publishMock.mock.calls)).not.toContain('private query');
  });

  it('sends inspection URLs as data only to the fixed inspection API', async () => {
    const inspectionResult = { indexStatusResult: { verdict: 'PASS' } };
    respond({ inspectionResult });
    expect(await inspectUrl(OWNER, {
      siteUrl: 'https://example.com/', inspectionUrl: 'https://example.com/page', languageCode: 'en-US',
    })).toEqual({ inspectionResult });
    expect(fetch).toHaveBeenCalledWith('https://searchconsole.googleapis.com/v1/urlInspection/index:inspect',
      expect.objectContaining({ method: 'POST', body: expect.stringContaining('https://example.com/page') }));
  });

  it.each(allCalls.map((call, index) => ({ call, index })))('propagates provider failures and emits no success event ($index)', async ({ call }) => {
    vi.mocked(fetch).mockResolvedValue(new Response('', { status: 429 }));
    await expect(call()).rejects.toThrow('API error 429');
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('returns empty collections when Google omits arrays', async () => {
    vi.mocked(fetch).mockImplementation(async () => new Response('{}'));
    expect(await listSites(OWNER)).toEqual({ sites: [] });
    expect(await querySearchAnalytics(OWNER, dates)).toEqual({ rows: [] });
    expect(await listLocations(OWNER, { accountId: '123' })).toEqual({ locations: [] });
    expect(await listReviews(OWNER, business)).toEqual({ reviews: [] });
  });

  it.each([
    { ...dates, rowLimit: 25001 }, { ...dates, rowLimit: 1.5 }, { ...dates, startRow: -1 },
    { ...dates, startRow: 1000001 }, { ...dates, startDate: '2026-02-30' },
    { ...dates, endDate: '2025-01-01' }, { ...dates, siteUrl: 'file:///etc/passwd' },
    { ...dates, siteUrl: 'https://user:pass@example.com/' },
  ])('rejects invalid analytics input before credentials', async (options) => {
    await expect(querySearchAnalytics(OWNER, options)).rejects.toThrow();
    expect(credential).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects invalid inspection protocols and language codes', async () => {
    await expect(inspectUrl(OWNER, { siteUrl: dates.siteUrl, inspectionUrl: 'ftp://example.com' })).rejects.toThrow();
    await expect(inspectUrl(OWNER, { siteUrl: dates.siteUrl, inspectionUrl: 'https://example.com', languageCode: '../' })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('carries the selected org slot into Business approval, credential lookup and signed audit', async () => {
    approval.mockImplementation(async (owner: string) => {
      expect(owner).toBe(OWNER);
      expect(currentConnectionSlot('google', owner)).toBe('work');
    });
    credential.mockImplementation(async (owner: string, scope: string) => {
      expect(owner).toBe(OWNER);
      expect(scope).toBe(BUSINESS_PROFILE_SCOPE);
      expect(currentConnectionSlot('google', owner)).toBe('work');
      return 'mock-access-token';
    });
    const response = await rpc('google_business_profile_list_reviews',
      { ...business, connection: 'Company' }, [BUSINESS_PROFILE_SCOPE]);
    expect(response).toMatchObject({ result: { isError: false } });
    expect(approval).toHaveBeenCalledWith(OWNER);
    expect(publishMock).toHaveBeenCalledWith('google.data.read', expect.objectContaining({
      payload: expect.objectContaining({ onBehalfOf: OWNER, slot: 'work', operation: 'business-profile.reviews.list' }),
    }));
  });
});

describe('Business Profile', () => {
  it.each([undefined, '', 'false', 'TRUE', '1', ' true '])('defaults off unless exact true (%s)', async (flag) => {
    vi.stubEnv('GOOGLE_BUSINESS_PROFILE_ENABLED', flag);
    expect(isBusinessProfileEnabled()).toBe(false);
    await expect(listLocations(OWNER, business)).rejects.toThrow('google_business_profile_disabled');
    await expect(listReviews(OWNER, business)).rejects.toThrow('google_business_profile_disabled');
    expect(approval).not.toHaveBeenCalled();
    expect(credential).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('requires per-owner project approval before credentials', async () => {
    approval.mockRejectedValue(new Error('google_business_profile_approval_pending'));
    await expect(listLocations(OWNER, business)).rejects.toThrow('approval_pending');
    await expect(listReviews(OWNER, business)).rejects.toThrow('approval_pending');
    expect(approval).toHaveBeenCalledWith(OWNER);
    expect(credential).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('lists one locations page at Information v1 with required readMask and cursor', async () => {
    const data = { locations: [{ name: 'locations/456', title: 'Private shop' }], nextPageToken: 'next' };
    respond(data);
    expect(await listLocations(OWNER, { accountId: '123', pageSize: 10, pageToken: 'previous+/=' })).toEqual(data);
    const url = new URL(vi.mocked(fetch).mock.calls[0][0] as string);
    expect(url.origin).toBe('https://mybusinessbusinessinformation.googleapis.com');
    expect(url.pathname).toBe('/v1/accounts/123/locations');
    expect(url.searchParams.get('readMask')).toContain('name,title');
    expect(url.searchParams.get('pageToken')).toBe('previous+/=');
    expect(url.searchParams.get('pageSize')).toBe('10');
    expect(credential).toHaveBeenCalledWith(OWNER, BUSINESS_PROFILE_SCOPE);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('uses reviews v4 and preserves cursor/rating metadata without auditing review PII', async () => {
    const data = { reviews: [{ reviewId: 'r1', reviewer: { displayName: 'Private person' }, comment: 'Private comment' }],
      nextPageToken: 'next', averageRating: 4, totalReviewCount: 70 };
    respond(data);
    expect(await listReviews(OWNER, { ...business, pageToken: 'old', orderBy: 'updateTime desc' })).toEqual(data);
    const url = new URL(vi.mocked(fetch).mock.calls[0][0] as string);
    expect(url.origin).toBe('https://mybusiness.googleapis.com');
    expect(url.pathname).toBe('/v4/accounts/123/locations/456/reviews');
    expect(url.searchParams.get('pageToken')).toBe('old');
    expect(url.searchParams.get('orderBy')).toBe('updateTime desc');
    expect(JSON.stringify(publishMock.mock.calls)).not.toContain('Private');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    { accountId: '../evil' }, { accountId: 'https://evil.test' },
    { accountId: '123', pageSize: 101 }, { accountId: '123', pageToken: 'a'.repeat(4097) },
  ])('rejects path injection and unbounded locations input', async (options) => {
    await expect(listLocations(OWNER, options)).rejects.toThrow();
    expect(credential).not.toHaveBeenCalled();
  });
  it('rejects review path injection and oversized pages', async () => {
    await expect(listReviews(OWNER, { ...business, locationId: '../evil' })).rejects.toThrow();
    await expect(listReviews(OWNER, { ...business, pageSize: 51 })).rejects.toThrow();
    expect(credential).not.toHaveBeenCalled();
  });
});

describe('MCP app/owner/connection path', () => {
  it.each([
    ['google_search_console_list_sites', SEARCH_CONSOLE_SCOPE, {}],
    ['google_search_console_query_analytics', SEARCH_CONSOLE_SCOPE, dates],
    ['google_search_console_inspect_url', SEARCH_CONSOLE_SCOPE, { siteUrl: dates.siteUrl, inspectionUrl: 'https://example.com/page' }],
    ['google_business_profile_list_locations', BUSINESS_PROFILE_SCOPE, { accountId: business.accountId }],
    ['google_business_profile_list_reviews', BUSINESS_PROFILE_SCOPE, business],
  ] as const)('executes %s through live app grant and mocked Google API', async (name, scope, args) => {
    const response = await rpc(name, args, [scope]);
    expect(response).toMatchObject({ result: { isError: false } });
    expect(appGrant).toHaveBeenCalledWith(OWNER, scope, APP);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(publishMock).toHaveBeenCalledTimes(1);
  });
  it('registers five distinct, correctly scoped descriptors', () => {
    const tools = [...searchConsoleTools, ...businessProfileTools];
    expect(new Set(tools.map((tool) => tool.name)).size).toBe(5);
    for (const tool of searchConsoleTools) expect(tool.requiredScope).toBe(SEARCH_CONSOLE_SCOPE);
    for (const tool of businessProfileTools) expect(tool.requiredScope).toBe(BUSINESS_PROFILE_SCOPE);
  });
  it('denies missing token scope before any provider or app grant call', async () => {
    const response = await rpc('google_search_console_list_sites', {}, []);
    expect(response).toMatchObject({ result: { isError: true, content: [{ text: expect.stringContaining('insufficient_scope') }] } });
    expect(appGrant).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    ['google_search_console_list_sites', SEARCH_CONSOLE_SCOPE, {}],
    ['google_business_profile_list_reviews', BUSINESS_PROFILE_SCOPE, business],
  ] as const)('rechecks revoked app grants for %s despite valid token scope', async (name, scope, args) => {
    appGrant.mockRejectedValue(new Error('mcp_no_grant'));
    const response = await rpc(name, args, [scope]);
    expect(response).toMatchObject({ result: { isError: true, content: [{ text: expect.stringContaining('mcp_no_grant') }] } });
    expect(appGrant).toHaveBeenCalledWith(OWNER, scope, APP);
    expect(credential).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('binds org identity and named slot through app grant, credential, Google and audit', async () => {
    credential.mockImplementation(async (owner: string) => {
      expect(owner).toBe(OWNER);
      expect(currentConnectionSlot('google', owner)).toBe('work');
      return 'mock-access-token';
    });
    const response = await rpc('google_search_console_list_sites', { connection: 'Company' }, [SEARCH_CONSOLE_SCOPE]);
    expect(response).toMatchObject({ result: { isError: false } });
    expect(appGrant).toHaveBeenCalledWith(OWNER, SEARCH_CONSOLE_SCOPE, APP);
    expect(registrations).toHaveBeenCalledWith(OWNER);
    expect(publishMock).toHaveBeenCalledWith('google.data.read', expect.objectContaining({
      issuer: OWNER, subject: OWNER, payload: expect.objectContaining({ onBehalfOf: OWNER, slot: 'work' }),
    }));
  });
  it('rejects caller-supplied owner identifiers rather than allowing cross-identity reads', async () => {
    const response = await rpc('google_search_console_list_sites', { ownerDid: 'did:imajin:other' }, [SEARCH_CONSOLE_SCOPE]);
    expect(response).toMatchObject({ result: { isError: true } });
    expect(fetch).not.toHaveBeenCalled();
  });
});
