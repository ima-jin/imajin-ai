import type { EdgeClassification } from '../../jin/cloudflare-classification-client';
import type { DnsRecord } from '../../jin/cloudflare-client';

/** Illustrative UI fixture only; never used by production classification or its route inventory. */
export const imajinFixtureRecords: DnsRecord[] = [
  { id: '1'.repeat(32), type: 'A', name: 'kernel.imajin.ai', content: '192.0.2.10', ttl: 1, proxied: true },
  { id: '2'.repeat(32), type: 'A', name: 'www.imajin.ai', content: '192.0.2.11', ttl: 1, proxied: false },
  { id: '3'.repeat(32), type: 'CNAME', name: 'thirdparty.imajin.ai', content: 'fixture.vendor.invalid', ttl: 1, proxied: true },
  { id: '4'.repeat(32), type: 'MX', name: 'imajin.ai', content: 'mail.fixture.invalid', ttl: 300, proxied: false },
  { id: '5'.repeat(32), type: 'CNAME', name: '_verification.imajin.ai', content: 'proof.fixture.invalid', ttl: 300, proxied: true },
];

export const imajinClassificationFixture: EdgeClassification = {
  domain: 'imajin.ai',
  warnings: ['DEVELOPMENT FIXTURE — illustrative evidence, not a live scan or production recommendation.',
    'Unknown third-party route coverage stays DNS-only. Kernel SSE / long-running work needs a dedicated DNS-only host or carve-out.'],
  hosts: [
    { hostname: 'kernel.imajin.ai', proxied: false, reason: 'SSE and operations above the conservative 100s threshold block this host.',
      blockingRoutes: ['/api/chat/stream', '/api/jobs/run'], remedy: 'Keep DNS-only or move long-lived routes to a dedicated DNS-only hostname.',
      routes: [
        { path: '/api/chat/stream', method: 'POST', class: 'proxy-unsafe', reason: 'SSE lifetime is not bounded below 100s.', source: 'FIXTURE: kernel stream handler' },
        { path: '/api/jobs/run', method: 'POST', class: 'proxy-unsafe', reason: 'May exceed 100s; conservative headroom below the documented 125s read timeout.', source: 'FIXTURE: kernel job handler' },
        { path: '/api/session', method: 'GET', class: 'proxy-bypass', reason: 'Authenticated session API; never shared-cache.', source: 'FIXTURE: kernel session handler' },
      ], records: [{ recordId: imajinFixtureRecords[0].id, type: 'A', name: 'kernel.imajin.ai', before: true, after: false, reason: 'Host contains proxy-unsafe routes.' }] },
    { hostname: 'www.imajin.ai', proxied: true, reason: 'Public app assets can cache; authenticated APIs bypass cache.',
      blockingRoutes: [], routes: [
        { path: '/', method: 'GET', class: 'cacheable', reason: 'Public static app page without session state.', source: 'FIXTURE: app public page' },
        { path: '/api/profile', method: 'GET', class: 'proxy-bypass', reason: 'Authenticated API response.', source: 'FIXTURE: app profile handler' },
      ], records: [{ recordId: imajinFixtureRecords[1].id, type: 'A', name: 'www.imajin.ai', before: false, after: true, reason: 'Cache public content and bypass session/API traffic.' }] },
    { hostname: 'thirdparty.imajin.ai', proxied: false, reason: 'Third-party behavior has not been observed.',
      blockingRoutes: ['/*'], remedy: 'Collect route coverage, heartbeat/reconnect and upload evidence before reclassification.',
      routes: [{ path: '/*', method: 'ALL', class: 'unclassified', reason: 'No third-party runtime evidence.', source: 'FIXTURE: external CNAME discovery' }],
      records: [{ recordId: imajinFixtureRecords[2].id, type: 'CNAME', name: 'thirdparty.imajin.ai', before: true, after: false, reason: 'Unknown route coverage fails closed.' }] },
    { hostname: 'imajin.ai', proxied: false, reason: 'Mail records are never proxied.', blockingRoutes: [],
      routes: [{ path: '(mail)', method: 'DNS', class: 'never-proxied', reason: 'Mail transport is not HTTP.', source: 'FIXTURE: MX discovery' }],
      records: [{ recordId: imajinFixtureRecords[3].id, type: 'MX', name: 'imajin.ai', before: false, after: false, reason: 'Keep mail DNS-only.' }] },
    { hostname: '_verification.imajin.ai', proxied: false, reason: 'Verification CNAME must remain visible to the verifier.', blockingRoutes: [],
      routes: [{ path: '(verification)', method: 'DNS', class: 'never-proxied', reason: 'Verification is not application HTTP traffic.', source: 'FIXTURE: verification CNAME discovery' }],
      records: [{ recordId: imajinFixtureRecords[4].id, type: 'CNAME', name: '_verification.imajin.ai', before: true, after: false, reason: 'Preserve verification CNAME visibility.' }] },
  ],
  proxyBatches: [[
    { recordId: imajinFixtureRecords[0].id, proxied: false },
    { recordId: imajinFixtureRecords[1].id, proxied: true },
    { recordId: imajinFixtureRecords[2].id, proxied: false },
    { recordId: imajinFixtureRecords[4].id, proxied: false },
  ]],
  cacheRules: [
    { description: 'FIXTURE: public app pages', expression: '(http.host eq "www.imajin.ai" and http.request.method eq "GET" and http.request.uri.path eq "/")',
      action: 'set_cache_settings', enabled: true, action_parameters: { cache: true } },
    { description: 'FIXTURE: bypass authenticated / API traffic', expression: '(http.cookie ne "" or any(http.request.headers["authorization"][*] ne "") or starts_with(http.request.uri.path, "/api/"))',
      action: 'set_cache_settings', enabled: true, action_parameters: { cache: false } },
  ],
};
