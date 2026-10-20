import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { SERVICES, buildPublicUrl, type ServiceDefinition } from '@imajin/config';
import { configuredNodeUrl } from '../http/node-url';
import { listApiSpecServices, readApiSpec } from '../kernel/api-specs';
import type { ZoneAuthority } from './authority';
import { dnsRecordSchema } from './schemas';
import type { CacheRule, DnsRecord } from '../../../app/jin/cloudflare-client';
import { loadRegistryEdgeSpec } from './edge-spec-loader';
import { listRegisteredEdgeApps, type RegisteredEdgeApp } from './edge-registry';
import {
  classifySpec, deduplicateRoutes, scanKernelRoutes, mergeSourceAndSpecs, specRoutePrefix,
  type ClassifiedRoute, type HostManifest, type EdgeSpecDocument,
} from './classification-source';

export type { ClassifiedRoute, HostManifest, EdgeClass } from './classification-source';
export interface ClassifiedRecord {
  recordId: string; type: string; name: string; before: boolean; after: boolean; reason: string;
}
export interface ClassifiedHost {
  hostname: string; proxied: boolean; reason: string; blockingRoutes: string[]; remedy?: string;
  routes: ClassifiedRoute[]; records: ClassifiedRecord[];
}
export interface ClassificationReport {
  domain: string;
  hosts: ClassifiedHost[];
  proxyBatches: { recordId: string; proxied: boolean }[][];
  cacheRules: CacheRule[];
  warnings: string[];
}
export interface ClassificationOptions {
  /** Caller supplies a trusted node origin; never take this from a request. */
  kernelDirectory?: string;
  kernelOrigin?: string;
  /** Only called for absolute spec URLs derived from SERVICES configuration. */
  loadExternalSpec?: (url: string) => Promise<unknown>;
  /** Observed/trusted origin TLS configuration, never inferred from DNS names. */
  tlsAlpnHosts?: readonly string[];
  registeredApps?: readonly RegisteredEdgeApp[];
}
const WEB_TYPES = new Set(['A', 'AAAA', 'CNAME']);
const BLOCKING = new Set(['proxy-unsafe', 'never-proxied', 'unclassified']);
const dnsName = (name: string) => name.toLowerCase().replace(/\.$/, '');
const inZone = (name: string, domain: string) => name === domain || name.endsWith(`.${domain}`);
const literalHost = (name: string) => name.length <= 253 && name.includes('.')
  && name.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
const literalPath = (path: string) => path.length <= 1024 && /^\/[a-zA-Z0-9/._~-]*$/.test(path);
interface HostEntry { records: DnsRecord[]; routes: ClassifiedRoute[] }

function aliasRestriction(record: DnsRecord, hosts: Map<string, HostEntry>, seen = new Set<string>()): string | undefined {
  if (record.type !== 'CNAME') return undefined;
  const target = dnsName(record.content);
  if (seen.has(target)) return 'CNAME chain is cyclic; keep DNS-only';
  seen.add(target);
  const entry = hosts.get(target);
  if (!entry?.routes.length || entry.routes.some(route => BLOCKING.has(route.class))) {
    return 'CNAME target has unknown or unsafe transport traits; keep DNS-only';
  }
  for (const alias of entry.records) {
    const restriction = aliasRestriction(alias, hosts, seen);
    if (restriction) return restriction;
  }
  return undefined;
}

function recordRestriction(record: DnsRecord, domain: string, mailTargets: Set<string>): string | undefined {
  if (!WEB_TYPES.has(record.type)) return 'Mail, TXT/SPF/DKIM/DMARC, verification and non-HTTP DNS records are never proxied';
  const name = dnsName(record.name);
  if (name.split('.').some(label => label.startsWith('_') || ['mail', 'smtp', 'imap', 'pop', 'pop3', 'mx', 'autodiscover', 'autoconfig'].includes(label)) || mailTargets.has(name)) {
    return 'Mail, certificate challenge or verification hostname is never proxied';
  }
  if (record.proxiable === false) return 'Provider marks this record non-proxiable';
  if (record.type === 'CNAME' && !inZone(dnsName(record.content), domain)) {
    return 'Third-party CNAME target has no trusted edge compatibility evidence; keep DNS-only';
  }
  return undefined;
}

/** Pure proposal only: no provider writes, approval staging or secret access. */
export function buildClassificationReport(domain: string, records: readonly DnsRecord[], manifests: readonly HostManifest[], warnings: readonly string[] = []): ClassificationReport {
  domain = dnsName(domain);
  if (!literalHost(domain)) throw new Error('Invalid classification domain');
  const byHost = new Map<string, HostEntry>();
  if (new Set(records.map(record => record.id)).size !== records.length) throw new Error('Duplicate classification record IDs');
  const mailTargets = new Set(records.filter(record => record.type === 'MX').map(record => dnsName(record.content)));
  for (const manifest of manifests) {
    const hostname = dnsName(manifest.hostname);
    if (!inZone(hostname, domain)) continue;
    const host = byHost.get(hostname) ?? { records: [], routes: [] };
    host.routes.push(...manifest.routes);
    byHost.set(hostname, host);
  }
  for (const record of records) {
    const hostname = dnsName(record.name);
    if (!inZone(hostname, domain)) throw new Error('Classification record outside zone');
    const host = byHost.get(hostname) ?? { records: [], routes: [] };
    host.records.push(record);
    byHost.set(hostname, host);
  }
  const hosts: ClassifiedHost[] = [...byHost].sort(([a], [b]) => a.localeCompare(b)).map(([hostname, entry]) => {
    const routes = deduplicateRoutes(entry.routes);
    const blockers = routes.filter(route => BLOCKING.has(route.class));
    const webRecords = entry.records.filter(record => WEB_TYPES.has(record.type));
    const restrictions = webRecords.map(record => recordRestriction(record, domain, mailTargets) ?? aliasRestriction(record, byHost)).filter((reason): reason is string => !!reason);
    const proxied = literalHost(hostname) && !!routes.length && !blockers.length && !restrictions.length && !!webRecords.length;
    const reason = hostReason(hostname, routes.length, blockers.length, restrictions, webRecords.length);
    return {
      hostname, proxied, reason,
      blockingRoutes: blockers.map(route => `${route.method} ${route.path}`),
      ...(!proxied && webRecords.length ? { remedy: 'Keep DNS-only. Bound uploads/deadlines, validate client-IP handling, or isolate unsafe routes onto a separate DNS-only host; reclassify before approval.' } : {}),
      routes,
      records: entry.records.slice().sort((a, b) => a.id.localeCompare(b.id)).map(record => ({
        recordId: record.id, type: record.type, name: record.name, before: record.proxied === true,
        after: proxied && !recordRestriction(record, domain, mailTargets),
        reason: recordRestriction(record, domain, mailTargets) ?? reason,
      })),
    };
  });
  const changes = hosts.flatMap(host => host.records.filter(record => record.before !== record.after && WEB_TYPES.has(record.type))
    .map(record => ({ recordId: record.recordId, proxied: record.after })));
  const proxyBatches: ClassificationReport['proxyBatches'] = [];
  for (let offset = 0; offset < changes.length; offset += 20) proxyBatches.push(changes.slice(offset, offset + 20));
  const reportWarnings = [...warnings];
  const cacheRules = buildCacheRules(hosts, reportWarnings);
  return { domain, hosts, proxyBatches, cacheRules, warnings: [...new Set(reportWarnings)].sort() };
}

function hostReason(hostname: string, routes: number, blockers: number, restrictions: string[], records: number): string {
  if (restrictions.length) return [...new Set(restrictions)].sort().join('; ');
  if (!routes) return 'No trusted source/spec manifest for this host; keep DNS-only';
  if (blockers) return 'One or more unsafe, never-proxied or unclassified routes blocks the entire host';
  if (!literalHost(hostname)) return 'Wildcard/invalid hostname cannot be proven safe';
  if (!records) return 'No HTTP DNS records to proxy';
  return 'Every route is classified and proxy-compatible; APIs and session requests bypass cache';
}

/** Default bypass first; narrowly proven static exceptions never override auth. */
export function buildCacheRules(hosts: readonly ClassifiedHost[], warnings: string[] = []): CacheRule[] {
  const rules: CacheRule[] = [{
    ref: 'edge_default_bypass', description: 'Default bypass: API, authenticated, unknown and DNS-only traffic',
    expression: 'true', action: 'set_cache_settings', enabled: true, action_parameters: { cache: false },
  }];
  for (const host of hosts.filter(host => host.proxied && literalHost(host.hostname))) {
    const paths = host.routes.filter(route => route.class === 'cacheable' && route.method === 'GET' && literalPath(route.path)
      && !host.routes.some(other => other.path === route.path && other.class !== 'cacheable')).map(route => route.path);
    for (const path of [...new Set(paths)].sort()) {
      // Leave one final rule for credentials, and stay within connector bounds.
      if (rules.length >= 19) { warnings.push('Cache rule limit reached; remaining static paths safely retain default bypass'); break; }
      rules.push({
        ref: `edge_static_${rules.length}`, description: `Public static ${host.hostname}${path}`.slice(0, 200),
        expression: `(http.host eq "${host.hostname}" and http.request.uri.path eq "${path}" and http.request.uri.query eq "" and http.request.method in {"GET" "HEAD"} and http.cookie eq "" and not any(http.request.headers.names[*] eq "authorization"))`,
        action: 'set_cache_settings', enabled: true,
        action_parameters: { cache: true, edge_ttl: { mode: 'respect_origin' }, browser_ttl: { mode: 'respect_origin' } },
      });
    }
  }
  rules.push({
    ref: 'edge_credentials_bypass', description: 'Never cache cookie, token or app-authenticated requests',
    expression: '(http.cookie ne "" or any(http.request.headers.names[*] in {"authorization" "proxy-authorization" "x-api-key" "x-app-did"}))',
    action: 'set_cache_settings', enabled: true, action_parameters: { cache: false },
  });
  return rules;
}

function kernelDirectory(): string {
  const cwd = process.cwd();
  return existsSync(join(cwd, 'app')) ? cwd : resolve(cwd, 'apps/kernel');
}

/**
 * Registry URLs are topology, not DNS record contents. Local kernel specs are
 * read in process; standalone app specs use the bounded, DNS-pinned loader.
 */
export async function deriveHostManifests(domain: string, options: ClassificationOptions = {}): Promise<{ manifests: HostManifest[]; warnings: string[] }> {
  const origin = options.kernelOrigin ?? configuredNodeUrl();
  const kernelHost = origin ? new URL(origin).hostname : domain;
  const manifests: HostManifest[] = [{ hostname: kernelHost, routes: scanKernelRoutes(options.kernelDirectory ?? kernelDirectory()) }];
  const warnings: string[] = [];
  if (!origin) {
    warnings.push('Trusted kernel origin is not configured; do not assume every verified zone points to this node');
    manifests[0].routes.push({ path: '/', method: '*', class: 'unclassified', reason: 'Missing trusted kernel origin configuration', source: 'registry configuration' });
  }
  for (const hostname of options.tlsAlpnHosts ?? []) {
    manifests.push({ hostname, routes: [{ path: '/.well-known/acme-challenge/{token}', method: '*', class: 'never-proxied',
      reason: 'Caddy TLS-ALPN validation needs direct origin TLS; HTTP cache bypass cannot preserve the ALPN handshake', source: 'trusted TLS configuration' }] });
  }
  const local = localSpecInventory();
  manifests[0].routes = mergeSourceAndSpecs(manifests[0].routes, local.documents);
  manifests[0].routes.push(...local.routes);
  const services = await serviceManifests(kernelHost, origin, options);
  const apps = await registeredManifests(domain, kernelHost, origin, options);
  manifests.push(...services.manifests, ...apps.manifests);
  warnings.push(...services.warnings, ...apps.warnings);
  return { manifests, warnings };
}

/** Enumerate all local specs, including connectors absent from SERVICES. */
function localSpecInventory(): { documents: EdgeSpecDocument[]; routes: ClassifiedRoute[] } {
  const routes: ClassifiedRoute[] = [];
  const documents: EdgeSpecDocument[] = [];
  for (const service of listApiSpecServices()) {
    const raw = readApiSpec(service);
    if (!raw || raw.truncated) {
      routes.push({ path: `/${service}`, method: '*', class: 'unclassified', reason: 'Kernel spec is missing or truncated', source: `api-spec/${service}.yaml` });
      continue;
    }
    try {
      const document = parseYaml(raw.content);
      documents.push({ document, source: `api-spec/${service}.yaml`, prefix: specRoutePrefix(document, `/${service}`) });
    } catch {
      routes.push({ path: `/${service}`, method: '*', class: 'unclassified', reason: 'Kernel spec cannot be parsed', source: `api-spec/${service}.yaml` });
    }
  }
  return { documents, routes };
}

async function serviceManifests(kernelHost: string, origin: string | null, options: ClassificationOptions) {
  const manifests: HostManifest[] = [];
  const warnings: string[] = [];
  for (const service of SERVICES) {
    if (!service.devPort || service.externalUrl || service.wwwPath || service.name === 'kernel') continue;
    if (options.registeredApps?.some(app => app.slug === service.name)) continue;
    const configured = buildPublicUrl(service.name);
    const url = new URL(configured || '/', `https://${kernelHost}`);
    const host = url.hostname;
    const sameNode = host === kernelHost && service.devPort === 3000;
    if (sameNode) continue;
    const specOptions = !origin && !/^https:\/\//.test(configured) ? { ...options, loadExternalSpec: undefined } : options;
    const { document, source } = await serviceSpec(service, url, specOptions, warnings);
    if (!sameNode && !document) warnings.push(`Missing trusted spec for ${service.name}; host remains DNS-only`);
    const routes = classifySpec(document, source, url.pathname.replace(/\/$/, ''));
    manifests.push({ hostname: host, routes });
  }
  return { manifests, warnings };
}

async function registeredManifests(domain: string, kernelHost: string, origin: string | null, options: ClassificationOptions) {
  const manifests: HostManifest[] = [];
  const warnings: string[] = [];
  for (const app of options.registeredApps ?? []) {
    if (!app.baseUrl || !origin) {
      manifests.push({ hostname: kernelHost, routes: [{ path: `/${app.slug}`, method: '*', class: 'unclassified', reason: 'Active registered app has no trusted API base or node origin', source: `registry.apps/${app.slug}` }] });
      continue;
    }
    const base = new URL(app.baseUrl, origin);
    if (!inZone(base.hostname, domain)) continue;
    if (base.origin === new URL(origin).origin && base.pathname === '/') continue;
    const source = `${base.href.replace(/\/$/, '')}/api/spec`;
    let document: unknown;
    try { document = await options.loadExternalSpec?.(source); }
    catch { warnings.push(`Registered app spec unavailable: ${app.slug}; host remains DNS-only`); }
    manifests.push({ hostname: base.hostname, routes: classifySpec(document, source, base.pathname.replace(/\/$/, '')) });
  }
  return { manifests, warnings };
}


async function serviceSpec(service: ServiceDefinition, url: URL, options: ClassificationOptions, warnings: string[]): Promise<{ document: unknown; source: string }> {
  let document: unknown;
  let source = `api-spec/${service.name}.yaml`;
  if (options.loadExternalSpec) {
    source = `${url.href.replace(/\/$/, '')}/api/spec`;
    try { document = await options.loadExternalSpec(source); } catch { warnings.push(`Trusted registry spec unavailable: ${service.name}`); }
  }
  return { document, source };
}

/** Authorized read-only GET dependency; never fetches specs from this node. */
export async function classificationReport(authority: ZoneAuthority, options: ClassificationOptions = {}): Promise<ClassificationReport> {
  const records = await authority.client.list('/dns_records', dnsRecordSchema);
  const registeredApps = options.registeredApps ?? await listRegisteredEdgeApps();
  const { manifests, warnings } = await deriveHostManifests(authority.domain, {
    ...options, registeredApps, loadExternalSpec: options.loadExternalSpec ?? loadRegistryEdgeSpec,
  });
  return buildClassificationReport(authority.domain, records, manifests, warnings);
}
