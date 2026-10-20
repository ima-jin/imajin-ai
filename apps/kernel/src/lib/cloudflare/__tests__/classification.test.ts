import { describe, expect, it, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DnsRecord } from '../../../../app/jin/cloudflare-client';
import type { ZoneAuthority } from '../authority';
import { buildClassificationReport, classificationReport, deriveHostManifests } from '../classification';
import { classifySpec, inspectSource, scanKernelRoutes, type ClassifiedRoute } from '../classification-source';

vi.mock('../../kernel/api-specs', () => ({
  listApiSpecServices: () => ['auth'],
  readApiSpec: () => ({ content: 'openapi: "3.1.0"\npaths:\n  /api/public:\n    get:\n      responses: {}', truncated: false }),
}));

const record = (name = 'example.com', patch: Partial<DnsRecord> = {}): DnsRecord => ({
  id: 'a'.repeat(32), type: 'A', name, content: '192.0.2.1', ttl: 1, proxied: false, ...patch,
});
const route = (patch: Partial<ClassifiedRoute> = {}): ClassifiedRoute => ({
  path: '/api/public', method: 'GET', class: 'proxy-bypass', reason: 'Public API bypass', source: 'route.ts', ...patch,
});
function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'edge-classifier-'));
  for (const [name, text] of Object.entries(files)) {
    const filename = join(dir, name);
    mkdirSync(join(filename, '..'), { recursive: true });
    writeFileSync(filename, text);
  }
  return dir;
}

afterEach(() => vi.unstubAllEnvs());

describe('deterministic host proposals', () => {
  it('a single unsafe route disables every web record on the host', () => {
    const records = [record(), record('example.com', { id: 'b'.repeat(32), type: 'AAAA', content: '2001:db8::1', proxied: true })];
    const report = buildClassificationReport('example.com', records, [{ hostname: 'example.com', routes: [route(), route({ path: '/stream', class: 'proxy-unsafe' })] }]);
    expect(report.hosts[0]).toMatchObject({ proxied: false, blockingRoutes: ['GET /stream'] });
    expect(report.hosts[0].records.every(record => !record.after)).toBe(true);
    expect(report.proxyBatches).toEqual([[{ recordId: 'b'.repeat(32), proxied: false }]]);
    expect(report.cacheRules.every(rule => !rule.action_parameters.cache)).toBe(true);
  });

  it('missing trusted specs and third-party CNAMEs stay DNS-only', () => {
    const report = buildClassificationReport('example.com', [
      record('unknown.example.com', { proxied: true }),
      record('docs.example.com', { id: 'b'.repeat(32), type: 'CNAME', content: 'docs.vendor.test', proxied: true }),
    ], [{ hostname: 'docs.example.com', routes: [route()] }]);
    expect(report.hosts.every(host => !host.proxied)).toBe(true);
    expect(report.hosts.find(host => host.hostname.startsWith('docs'))?.reason).toContain('Third-party');
    expect(report.hosts.find(host => host.hostname.startsWith('unknown'))?.reason).toContain('No trusted');
  });

  it.each([
    ['MX', 'example.com', 'post.example.com'],
    ['TXT', 'example.com', 'v=spf1 -all'],
    ['TXT', '_dmarc.example.com', 'v=DMARC1; p=reject'],
    ['CNAME', 'selector._domainkey.example.com', 'keys.vendor.test'],
    ['CNAME', '_verification.example.com', 'proof.vendor.test'],
    ['A', 'mail.example.com', '192.0.2.2'],
    ['CNAME', '_acme-challenge.example.com', '_acme-challenge.vendor.test'],
  ])('never proxies %s %s', (type, name, content) => {
    const report = buildClassificationReport('example.com', [record(name, { type, content })], [{ hostname: name, routes: [route()] }]);
    expect(report.hosts[0].records[0].after).toBe(false);
    expect(report.hosts[0].records[0].reason).toMatch(/never|Third-party/);
  });

  it('protects MX targets even when their A hostname is not named mail', () => {
    const report = buildClassificationReport('example.com', [
      record('example.com', { type: 'MX', content: 'post.example.com' }),
      record('post.example.com', { id: 'b'.repeat(32), proxied: true }),
    ], [{ hostname: 'post.example.com', routes: [route()] }]);
    expect(report.hosts.find(host => host.hostname === 'post.example.com')?.proxied).toBe(false);
  });

  it('does not orange-cloud an alias to an unsafe origin', () => {
    const report = buildClassificationReport('example.com', [
      record('www.example.com', { type: 'CNAME', content: 'origin.example.com' }),
      record('origin.example.com', { id: 'b'.repeat(32) }),
    ], [
      { hostname: 'www.example.com', routes: [route()] },
      { hostname: 'origin.example.com', routes: [route({ class: 'proxy-unsafe' })] },
    ]);
    expect(report.hosts.every(host => !host.proxied)).toBe(true);
  });

  it('limits batches to 20 and does not propose no-op records', () => {
    const records = Array.from({ length: 43 }, (_, i) => record('example.com', { id: i.toString(16).padStart(32, '0') }));
    const report = buildClassificationReport('example.com', records, [{ hostname: 'example.com', routes: [route()] }]);
    expect(report.proxyBatches.map(batch => batch.length)).toEqual([20, 20, 3]);
    expect(report.proxyBatches.flat().every(change => change.proxied)).toBe(true);
    expect(buildClassificationReport('example.com', [record('example.com', { proxied: true })], [{ hostname: 'example.com', routes: [route()] }]).proxyBatches).toEqual([]);
    expect(buildClassificationReport('example.com', records.slice().reverse(), [{ hostname: 'example.com', routes: [route()] }])).toEqual(report);
  });

  it('fails closed on unknown routes and records outside the authorized zone', () => {
    expect(buildClassificationReport('example.com', [record()], [{ hostname: 'example.com', routes: [route({ class: 'unclassified' })] }]).hosts[0].proxied).toBe(false);
    expect(() => buildClassificationReport('example.com', [record('other.test')], [])).toThrow('outside zone');
    expect(() => buildClassificationReport('example.com', [record(), record()], [])).toThrow('Duplicate');
  });
});

describe('cache proposals', () => {
  it('only permits exact static paths and excludes cookies and authorization', () => {
    const report = buildClassificationReport('example.com', [record()], [{ hostname: 'example.com', routes: [
      route(), route({ path: '/logo.svg', class: 'cacheable' }), route({ path: '/users/{id}', class: 'cacheable' }),
    ] }]);
    const allow = report.cacheRules.filter(rule => rule.action_parameters.cache);
    expect(allow).toHaveLength(1);
    expect(allow[0].expression).toContain('http.request.uri.path eq "/logo.svg"');
    expect(allow[0].expression).toContain('http.cookie eq ""');
    expect(allow[0].expression).toContain('authorization');
    expect(allow[0].expression).not.toContain('/api/public');
    expect(allow[0].action_parameters.edge_ttl?.mode).toBe('respect_origin');
    expect(report.cacheRules.at(-1)).toMatchObject({ ref: 'edge_credentials_bypass', action_parameters: { cache: false } });
  });

  it('stays under the connector max20 rule bound with safe bypass fallback', () => {
    const report = buildClassificationReport('example.com', [record()], [{ hostname: 'example.com', routes: Array.from({ length: 40 }, (_, i) => route({ path: `/asset${i}.png`, class: 'cacheable' })) }]);
    expect(report.cacheRules).toHaveLength(20);
    expect(report.warnings.join(' ')).toContain('limit');
    expect(report.cacheRules.at(-1)?.action_parameters.cache).toBe(false);
  });
});

describe('AST/source traits and OpenAPI', () => {
  it.each([
    ['new WebSocketServer({});', 'heartbeat'],
    ['new Response(null, {headers: {"Content-Type": "text/event-stream"}})', 'SSE'],
    ['await request.formData(); const file: File = null!; await file.arrayBuffer()', '100MB'],
    ['export const maxDuration = 101', '125s'],
    ['request.headers.get("x-forwarded-for")', 'CF-Connecting-IP'],
  ])('identifies transport hazards in %s', (text, reason) => {
    expect([...inspectSource(text).reasons].join(' ')).toContain(reason);
  });

  it('does not trust comments as socket evidence and checks CF header handling', () => {
    expect([...inspectSource('// WebSocket heartbeat reconnect\nexport function GET() { return Response.json({}); }').reasons]).toEqual([]);
    expect([...inspectSource('request.headers.get("CF-Connecting-IP") || request.headers.get("x-forwarded-for")').reasons]).toEqual([]);
    expect([...inspectSource('new WebSocket("wss://example.test"); /* heartbeat reconnect observed */').reasons].join(' ')).toContain('observed heartbeat AND reconnect evidence');
  });

  it('follows helper imports, factory destructuring and inherited layout auth', () => {
    const dir = fixture({
      'app/api/route.ts': 'import { factory } from "../../helper"; export const { GET, POST } = factory();',
      'helper.ts': 'export function factory(){ return {GET(){return new Response(new ReadableStream())},POST(){}} }',
      'app/private/page.tsx': 'export default function Page(){return <div>Hello</div>}',
      'app/private/layout.tsx': 'import { cookies } from "next/headers"; export default async function Layout({children}) {await cookies(); return children;}',
      'public/logo.svg': '<svg/>',
      'app/.well-known/info/route.ts': 'export function GET(){return Response.json({});}',
    });
    const routes = scanKernelRoutes(dir);
    expect(routes.filter(route => route.path === '/api').every(route => route.class === 'proxy-unsafe')).toBe(true);
    expect(routes.find(route => route.path === '/private')?.class).toBe('proxy-bypass');
    expect(routes.find(route => route.path === '/logo.svg')?.class).toBe('cacheable');
    expect(routes.find(route => route.path === '/.well-known/info')?.class).toBe('proxy-bypass');
  });

  it('all public APIs bypass and external refs need explicit override plus reason', () => {
    expect(classifySpec({ paths: { '/api/public': { get: { security: [], responses: {} } } } }, 'spec')[0].class).toBe('proxy-bypass');
    const ambiguous = { $ref: 'https://untrusted.test/spec' };
    expect(classifySpec({ paths: { '/api': { get: ambiguous } } }, 'spec')[0].class).toBe('unclassified');
    expect(classifySpec({ paths: { '/api': { get: { ...ambiguous, 'x-edge-class': 'proxy-unsafe', 'x-edge-reason': 'Opaque upstream deadline' } } } }, 'spec')[0].class).toBe('proxy-unsafe');
    expect(classifySpec({ paths: { '/api': { get: { ...ambiguous, 'x-edge-class': 'cacheable', 'x-edge-reason': 'public' } } } }, 'spec')[0].class).toBe('unclassified');
  });

  it('derives custom-server socket paths without treating code as observed evidence', () => {
    const dir = fixture({
      'app/api/route.ts': 'export function GET(){return Response.json({})}',
      'server.js': 'const socket = new WebSocket("ws://example.test"); if (parsedUrl.pathname === "/socket") socket.send("ping");',
    });
    const socket = scanKernelRoutes(dir).find(route => route.path === '/socket');
    expect(socket).toMatchObject({ method: 'UPGRADE', class: 'proxy-unsafe' });
    expect(socket?.reason).toContain('observed heartbeat AND reconnect evidence');
  });

  it('resolves local body refs and refuses to override proven streaming risk', () => {
    const spec = { components: { requestBodies: { Upload: { content: { 'multipart/form-data': {} } } } },
      paths: { '/upload': { post: { requestBody: { $ref: '#/components/requestBodies/Upload' }, 'x-edge-class': 'proxy-bypass', 'x-edge-reason': 'not evidence' } } } };
    expect(classifySpec(spec, 'spec')[0]).toMatchObject({ class: 'proxy-unsafe' });
    expect(classifySpec({ paths: { '/sse': { get: { responses: { 200: { content: { 'text/event-stream': {} } } }, 'x-edge-class': 'proxy-bypass', 'x-edge-reason': 'not evidence' } } } }, 'spec')[0].class).toBe('proxy-unsafe');
    expect(classifySpec({ paths: { '/unknown': { $ref: 'https://untrusted.test/path' } } }, 'spec')[0].class).toBe('unclassified');
  });
});

describe('read-only runtime and trusted registry loading', () => {
  it('reads DNS once and never performs mutations or default external fetches', async () => {
    const dir = fixture({ 'app/api/route.ts': 'export function GET(){ return Response.json({}); }' });
    const list = vi.fn().mockResolvedValue([record()]);
    const request = vi.fn();
    const authority = { domain: 'example.com', client: { list, request } } as unknown as ZoneAuthority;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected network'));
    const report = await classificationReport(authority, { kernelDirectory: dir });
    expect(list).toHaveBeenCalledOnce();
    expect(list.mock.calls[0][0]).toBe('/dns_records');
    expect(request).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(report.domain).toBe('example.com');
    fetchSpy.mockRestore();
  });


  it('allows reasoned source overrides only for ambiguity, never a known hazard', () => {
    const dir = fixture({
      'app/api/ambiguous/route.ts': '/* x-edge-class: proxy-unsafe\nx-edge-reason: Operator deadline has no bound */\nexport const maxDuration = Number(process.env.DEADLINE); export function POST(){}',
      'app/api/stream/route.ts': '/* x-edge-class: proxy-bypass\nx-edge-reason: Claimed safe */\nexport function GET(){return new Response(new ReadableStream())}',
      'app/api/broken/route.ts': '/* x-edge-class: proxy-bypass\nx-edge-reason: Claimed safe */\nexport const GET = missing;',
    });
    const routes = scanKernelRoutes(dir);
    expect(routes.find(route => route.path === '/api/ambiguous')?.class).toBe('proxy-unsafe');
    expect(routes.find(route => route.path === '/api/stream')?.class).toBe('proxy-unsafe');
    expect(routes.find(route => route.path === '/api/broken')?.class).toBe('unclassified');
  });
  it('only supplies configured registry spec URLs to an injectable loader', async () => {
    const dir = fixture({ 'app/api/route.ts': 'export function GET(){ return Response.json({}); }' });
    vi.stubEnv('NEXT_PUBLIC_EVENTS_URL', 'https://events.example.com');
    const loader = vi.fn().mockResolvedValue({ paths: { '/api/health': { get: {} } } });
    const result = await deriveHostManifests('example.com', { kernelDirectory: dir, loadExternalSpec: loader });
    expect(loader).toHaveBeenCalledOnce();
    expect(loader).toHaveBeenCalledWith('https://events.example.com/api/spec');
    expect(result.manifests.find(manifest => manifest.hostname === 'events.example.com')?.routes[0].class).toBe('proxy-bypass');
  });

  it('honors trusted TLS-ALPN topology and missing origin fail-closed', async () => {
    const dir = fixture({ 'app/api/route.ts': 'export function GET(){return Response.json({})}' });
    const result = await deriveHostManifests('example.com', { kernelDirectory: dir, tlsAlpnHosts: ['cert.example.com'] });
    expect(result.manifests.find(manifest => manifest.hostname === 'cert.example.com')?.routes[0].class).toBe('never-proxied');
    expect(result.warnings.join(' ')).toContain('Trusted kernel origin');
  });

  it('never self-calls even when a standalone service has an absolute node URL', async () => {
    const dir = fixture({ 'app/api/route.ts': 'export function GET(){return Response.json({})}' });
    vi.stubEnv('NEXT_PUBLIC_EVENTS_URL', 'https://example.com/events');
    const loader = vi.fn();
    await deriveHostManifests('example.com', { kernelDirectory: dir, kernelOrigin: 'https://example.com', loadExternalSpec: loader });
    expect(loader).not.toHaveBeenCalled();
  });
});
