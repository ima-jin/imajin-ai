import type { CacheRule, CustomHostname, DnsRecord } from '../../jin/cloudflare-client';

export const fixtureZoneId = 'a'.repeat(32);
export const fixtureGroup = 'did:imajin:fixture-zone-owners';
const actor = 'did:imajin:fixture-human';
const node = 'did:imajin:fixture-node';
export interface FixtureProposal { proposalId: string; kind: string; detail: unknown }
const json = (value: unknown, status = 200) => Response.json(value, { status });

/** Intercepts every request; unknown URLs never fall through to a real API. */
export function createCloudflarePreviewTransport(onProposal: (proposal: FixtureProposal) => void = () => undefined) {
  if (process.env.NODE_ENV !== 'development') throw new Error('Development fixture only');
  let records: DnsRecord[] = [
    { id: 'b'.repeat(32), type: 'A', name: 'www.example.com', content: '192.0.2.10', ttl: 1, proxied: false, proxiable: true },
    { id: 'c'.repeat(32), type: 'CNAME', name: 'assets.example.com', content: 'www.example.com', ttl: 1, proxied: true, proxiable: true },
    { id: 'd'.repeat(32), type: 'TXT', name: 'example.com', content: 'fixture-verification-only', ttl: 300, proxied: false, proxiable: false },
  ];
  const rules: CacheRule[] = [{
    id: 'e'.repeat(32), description: 'Static assets', expression: 'http.host eq "assets.example.com"',
    enabled: true, action: 'set_cache_settings', action_parameters: { cache: true },
  }];
  let hostnames: CustomHostname[] = [{
    id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', hostname: 'customer.example.net', status: 'pending',
    ownership_verification: { type: 'txt', name: '_cf-custom-hostname.customer.example.net', value: 'fixture-ownership-proof' },
    ssl: { status: 'pending_validation', validation_records: [{ txt_name: '_acme-challenge.customer.example.net', txt_value: 'fixture-dcv-proof' }] },
  }];
  let sequence = 0;
  let grants = [{ grantId: 'fixture-zone-grant', agentDid: 'did:imajin:fixture-agent',
    capabilities: ['cloudflare:read', 'cloudflare:dns'], expiry: '2026-10-21T00:00:00Z', revokedAt: null as string | null }];
  const grantRequest = (url: URL, method: string) => {
    if (url.pathname === '/jin/api/cloudflare-grants') {
      if (method === 'POST') grants = [...grants, { ...grants[0], grantId: `fixture-zone-grant-${++sequence}`, agentDid: 'did:imajin:fixture-member' }];
      return json(method === 'GET' ? { grants } : { grant: grants.at(-1) });
    }
    if (method === 'DELETE') grants = grants.map(grant => url.pathname.endsWith(grant.grantId)
      ? { ...grant, revokedAt: new Date().toISOString() } : grant);
    return json({ ok: true });
  };
  const stage = (kind: string, detail: unknown) => {
    const proposalId = `fixture-cloudflare-${++sequence}`;
    onProposal({ proposalId, kind, detail: {
      actor: { did: actor }, ownerDid: fixtureGroup, zoneId: fixtureZoneId, domain: 'example.com',
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      ...(kind.startsWith('cloudflare:') ? { operation: kind.slice('cloudflare:'.length) } : {}),
      ...detail as Record<string, unknown>,
    } });
    return { proposalId, status: 'pending', operatorDid: actor };
  };
  const dnsWrite = (resource: string, method: string, body: Record<string, unknown>) => {
    if (resource === 'dns') {
      records = [...records, { ...body, id: String(++sequence).padStart(32, '0'), proxiable: ['A', 'AAAA', 'CNAME'].includes(String(body.type)) } as unknown as DnsRecord];
      return json({ record: records.at(-1) }, 201);
    }
    const id = resource.slice(4);
    records = method === 'DELETE' ? records.filter((record) => record.id !== id)
      : records.map((record) => record.id === id ? { ...record, ...body } : record);
    return json({ record: records.find((record) => record.id === id) ?? { id } });
  };
  const bulkPlan = (body: Record<string, unknown>) => {
    const changes = (body.changes as { recordId: string; proxied: boolean }[]).map((change) => {
      const before = records.find((record) => record.id === change.recordId);
      return { recordId: change.recordId, before, after: { ...before, proxied: change.proxied } };
    });
    return json({ changes, dryRun: body.dryRun, ...(body.dryRun ? {} : { approval: stage('cloudflare:bulk-proxy', { changes }) }) }, body.dryRun ? 200 : 202);
  };
  const cachePlan = (body: Record<string, unknown>) => json({ before: rules, rules: body.rules, dryRun: body.dryRun,
    ...(body.dryRun ? {} : { approval: stage('cloudflare:cache-set', { before: rules, rules: body.rules }) }) }, body.dryRun ? 200 : 202);
  const hostnameRequest = (resource: string, method: string, body: Record<string, unknown>) => {
    if (resource === 'custom-hostnames') {
      if (method === 'POST') hostnames = [...hostnames, { ...hostnames[0], id: `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`, hostname: String(body.hostname) }];
      return json(method === 'GET' ? { hostnames } : { hostname: hostnames.at(-1) });
    }
    const id = resource.slice('custom-hostnames/'.length);
    const hostname = hostnames.find((item) => item.id === id);
    if (method === 'DELETE') hostnames = hostnames.filter((item) => item.id !== id);
    return json({ hostname });
  };
  const history = () => json({ history: [{
    id: 'fixture-history', issuerDid: node, issuedAt: '2026-10-20T00:00:00Z',
    payload: { actorDid: actor, onBehalfOf: fixtureGroup, zoneId: fixtureZoneId, operation: 'dns.update',
      phase: 'success', before: { proxied: false }, after: { proxied: true } },
    signature: 'FIXTURE_NOT_A_REAL_SIGNATURE',
  }] });
  const importRequest = (method: string) => {
    if (method !== 'GET') return json(stage('vault:import', { owner: fixtureGroup, consumer: node, purpose: `dns.cloudflare:${fixtureZoneId}` }), 202);
    return json({ ownerDid: actor, nodeDid: node,
      owners: [{ did: actor, name: 'Fixture human' }, { did: fixtureGroup, name: 'Fixture zone owners (group)' }],
      domains: [{ domain: 'example.com', ownerDid: fixtureGroup }], cards: [{
        field: 'vault-import:fixture-zone', ownerDid: fixtureGroup, consumerDid: node,
        purpose: `dns.cloudflare:${fixtureZoneId}`, fingerprint: 'FIXTURE_PUBLIC_FINGERPRINT',
        grantId: 'fixture-vault-grant', provenance: 'imported', status: 'active', timeline: [],
        cloudflare: { domain: 'example.com', zoneId: fixtureZoneId, granteeDid: 'did:imajin:fixture-agent',
          capabilities: ['cloudflare:read', 'cloudflare:dns'] },
      }] });
  };
  const dispatch = (resource: string, method: string, body: Record<string, unknown>) => {
    if (resource === 'dns' && method === 'GET') return json({ records });
    if (resource === 'dns' || resource.startsWith('dns/')) return dnsWrite(resource, method, body);
    if (resource === 'bulk') return bulkPlan(body);
    if (resource === 'cache-rules') return method === 'GET' ? json({ rules }) : cachePlan(body);
    if (resource === 'settings') return json({ settings: [{ id: 'ssl', value: 'strict', editable: true }] });
    if (resource === 'ssl') return json({ ssl: { id: 'ssl', value: 'strict', editable: true } });
    if (resource.startsWith('custom-hostnames')) return hostnameRequest(resource, method, body);
    if (resource === 'history') return history();
    return json({ error: 'fixture_only' }, 404);
  };
  const fetcher = async (input: RequestInfo | URL, options?: RequestInit): Promise<Response> => {
    const source = input instanceof Request ? input.url : String(input);
    const url = new URL(source, 'https://fixture.invalid');
    const method = options?.method ?? (input instanceof Request ? input.method : 'GET');
    // Import values are deliberately not parsed, retained, logged or echoed.
    if (url.pathname === '/api/vault/import') return importRequest(method);
    if (url.pathname === '/jin/api/cloudflare-grants' || url.pathname.startsWith('/auth/api/grants/fixture-zone-grant')) {
      return grantRequest(url, method);
    }
    const prefix = `/cloudflare/api/zones/${fixtureZoneId}/`;
    if (!url.pathname.startsWith(prefix) || url.searchParams.get('domain') !== 'example.com') return json({ error: 'fixture_only' }, 404);
    const text = await previewPayload(input, options, method);
    const body = text ? JSON.parse(text) as Record<string, unknown> : {};
    return dispatch(url.pathname.slice(prefix.length), method, body);
  };
  return { fetcher };
}

export function installCloudflarePreview(onProposal: (proposal: FixtureProposal) => void) {
  const fixture = createCloudflarePreviewTransport(onProposal);
  const previous = globalThis.fetch;
  globalThis.fetch = fixture.fetcher;
  return () => { globalThis.fetch = previous; };
}

function previewPayload(input: RequestInfo | URL, options: RequestInit | undefined, method: string): Promise<string> {
  if (typeof options?.body === 'string') return Promise.resolve(options.body);
  if (input instanceof Request && method !== 'GET') return input.text();
  return Promise.resolve('');
}
