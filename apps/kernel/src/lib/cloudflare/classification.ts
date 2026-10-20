import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { SERVICES, buildPublicUrl, type ServiceDefinition } from '@imajin/config';
import { listApiSpecServices, readApiSpec } from '../kernel/api-specs';
import type { ZoneAuthority } from './authority';
import { dnsRecordSchema } from './schemas';
import type { CacheRule, DnsRecord } from '../../../app/jin/cloudflare-client';
import {
  classifySpec, deduplicateRoutes, scanKernelRoutes,
  type ClassifiedRoute, type HostManifest,
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
 * Registry URLs are topology, not DNS record contents. External specs have no
 * default fetcher: the caller must supply a registry-trusting, SSRF-safe loader.
 */
export async function deriveHostManifests(domain: string, options: ClassificationOptions = {}): Promise<{ manifests: HostManifest[]; warnings: string[] }> {
  const configuredKernel = buildPublicUrl('kernel');
  const origin = options.kernelOrigin ?? (/^https?:\/\//.test(configuredKernel) ? configuredKernel : undefined)
    ?? process.env.NEXT_PUBLIC_BASE_URL;
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
  const available = new Set(listApiSpecServices());
  for (const service of SERVICES) {
    if (!service.devPort || service.externalUrl || service.wwwPath || service.name === 'kernel') continue;
    const configured = buildPublicUrl(service.name);
    const url = new URL(configured || '/', `https://${kernelHost}`);
    const host = url.hostname;
    const sameNode = host === kernelHost && service.devPort === 3000;
    const { document, source } = await serviceSpec(service, url, kernelHost, available, options, warnings);
    if (!sameNode && !document) warnings.push(`Missing trusted spec for ${service.name}; host remains DNS-only`);
    const routes = classifySpec(document, source, url.pathname.replace(/\/$/, ''));
    const existing = manifests.find(manifest => manifest.hostname === host);
    if (sameNode && existing) {
      // Code has authoritative transport evidence where the spec is incomplete.
      const keys = new Set(existing.routes.map(route => `${route.method} ${route.path}`));
      existing.routes.push(...routes.filter(route => !keys.has(`${route.method} ${route.path}`)));
    } else {
      manifests.push({ hostname: host, routes });
    }
  }
  return { manifests, warnings };
}

async function serviceSpec(service: ServiceDefinition, url: URL, kernelHost: string, available: Set<string>, options: ClassificationOptions, warnings: string[]): Promise<{ document: unknown; source: string }> {
  let document: unknown;
  let source = `api-spec/${service.name}.yaml`;
  const sameNode = url.hostname === kernelHost && service.devPort === 3000;
  if (sameNode && available.has(service.name)) {
    const raw = readApiSpec(service.name);
    if (raw && !raw.truncated) {
      try { document = parseYaml(raw.content); } catch { warnings.push(`Invalid local spec: ${service.name}`); }
    }
  } else if (url.hostname !== kernelHost && /^https:\/\//.test(buildPublicUrl(service.name)) && options.loadExternalSpec) {
    source = `${url.href.replace(/\/$/, '')}/api/spec`;
    try { document = await options.loadExternalSpec(source); } catch { warnings.push(`Trusted registry spec unavailable: ${service.name}`); }
  }
  return { document, source };
}

/** Authorized read-only GET dependency; never fetches specs from this node. */
export async function classificationReport(authority: ZoneAuthority, options: ClassificationOptions = {}): Promise<ClassificationReport> {
  const records = await authority.client.list('/dns_records', dnsRecordSchema);
  const { manifests, warnings } = await deriveHostManifests(authority.domain, options);
  return buildClassificationReport(authority.domain, records, manifests, warnings);
}
