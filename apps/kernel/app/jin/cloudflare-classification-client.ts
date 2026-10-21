import { isCacheRule, type CacheRule } from './cloudflare-client';

export const routeClasses = ['cacheable', 'proxy-bypass', 'proxy-unsafe', 'never-proxied', 'unclassified'] as const;
export type RouteClass = typeof routeClasses[number];
export interface ProxyChange { recordId: string; proxied: boolean }
export interface EdgeClassification {
  domain: string;
  hosts: {
    hostname: string; proxied: boolean; reason: string; blockingRoutes: string[]; remedy?: string;
    routes: { path: string; method: string; class: RouteClass; reason: string; source: string }[];
    records: { recordId: string; type: string; name: string; before: boolean; after: boolean; reason: string }[];
  }[];
  proxyBatches: ProxyChange[][];
  cacheRules: CacheRule[];
  warnings: string[];
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
const list = (value: unknown, guard: (item: unknown) => boolean): boolean => Array.isArray(value) && value.every(guard);
const fields = (value: Record<string, unknown>, keys: string[]): boolean => keys.every(key => typeof value[key] === 'string');
function isProxyChange(value: unknown): boolean {
  return object(value) && typeof value.recordId === 'string' && typeof value.proxied === 'boolean';
}
function isRoute(value: unknown): boolean {
  return object(value) && fields(value, ['path', 'method', 'reason', 'source']) && routeClasses.includes(value.class as RouteClass);
}
function isRecordDecision(value: unknown): boolean {
  return object(value) && fields(value, ['recordId', 'type', 'name', 'reason']) && typeof value.before === 'boolean' && typeof value.after === 'boolean';
}
function isHost(value: unknown): boolean {
  return object(value) && fields(value, ['hostname', 'reason']) && typeof value.proxied === 'boolean'
    && strings(value.blockingRoutes) && (value.remedy === undefined || typeof value.remedy === 'string')
    && list(value.routes, isRoute) && list(value.records, isRecordDecision);
}
/** Fail closed before any preview or proposal can be sent for malformed reports. */
export function isEdgeClassification(value: unknown): value is EdgeClassification {
  return object(value) && typeof value.domain === 'string' && strings(value.warnings)
    && list(value.cacheRules, isCacheRule) && list(value.proxyBatches, batch => list(batch, isProxyChange))
    && list(value.hosts, isHost);
}

export type ClassificationPlan = { resource: 'bulk' | 'cache-rules'; method: 'POST' | 'PUT'; body: { changes: ProxyChange[] } | { rules: CacheRule[] } };
export function classificationPlans(report: EdgeClassification): ClassificationPlan[] {
  // Rechunk defensively: the connector accepts at most 20 changes per proposal.
  const changes = report.proxyBatches.flat();
  if (new Set(changes.map(change => change.recordId)).size !== changes.length) throw new Error('Duplicate record plan');
  const plans: ClassificationPlan[] = [];
  for (let offset = 0; offset < changes.length; offset += 20) {
    plans.push({ resource: 'bulk', method: 'POST', body: { changes: changes.slice(offset, offset + 20) } });
  }
  // An empty ordered ruleset is still a replacement (removing stale cache rules).
  plans.push({
    resource: 'cache-rules', method: 'PUT',
    body: { rules: report.cacheRules.map(({ id: _id, ...rule }) => rule) },
  });
  return plans;
}
