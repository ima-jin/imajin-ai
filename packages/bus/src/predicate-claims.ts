import { createHash } from 'node:crypto';
import {
  brokerFieldEntry,
  brokerPredicatesForField,
  isBrokerPredicateName,
  normalizeBrokerTerm,
} from '@imajin/auth/broker-consent-vocabulary';
import type { BrokerPredicateClaim, BrokerPredicateRequest } from './types';

const DEFAULT_CLAIM_TTL_MS = 60 * 60 * 1000;

interface PredicateClaimOptions {
  subject: string;
  field: string;
  value: unknown;
  predicates: BrokerPredicateRequest | BrokerPredicateRequest[];
  now?: Date;
}

/**
 * Outcome of resolving one field's posed predicates.
 *
 * `claims` is what the requester receives. `cacheWrites` is what should be
 * persisted as warm cache rows — they differ for `overlaps`, which returns a
 * composed claim while caching only the `contains` primitives beneath it.
 */
export interface BrokerPredicateResolution {
  claims: BrokerPredicateClaim[];
  cacheWrites: BrokerPredicateClaim[];
}

interface CachedAttestationRow {
  id?: string;
  payload?: unknown;
  issued_at?: Date | string;
  expires_at?: Date | string | null;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort((a, b) => a.localeCompare(b));
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function normalizeScalar(value: unknown): unknown {
  if (typeof value === 'string') return value.trim();
  return value;
}

function normalizeTermForFallback(value: string): string {
  return value.trim().toLowerCase().replaceAll('-', '_').replaceAll(' ', '_');
}

function normalizeFieldTerm(field: string, value: string): string {
  const termVocabulary = brokerFieldEntry(field)?.termVocabulary;
  if (!termVocabulary) return normalizeTermForFallback(value);
  return normalizeBrokerTerm(termVocabulary, value) ?? normalizeTermForFallback(value);
}

function splitSetValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string | number | boolean => (
        typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean'
      ))
      .map((item) => String(item).trim())
      .filter((item) => item.length > 0);
  }
  if (typeof value === 'string') {
    return value
      .split(/[;,]/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  if (value === null || value === undefined) return [];
  return [String(value).trim()].filter((item) => item.length > 0);
}

function normalizeSet(field: string, value: unknown): string[] {
  return splitSetValue(value).map((item) => normalizeFieldTerm(field, item));
}

function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

function numericValue(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new Error(`Predicate requires a numeric value, received ${typeof value}`);
}

function compareOrdered(field: string, value: unknown, arg: unknown, predicate: 'gte' | 'lte'): boolean {
  const fieldEntry = brokerFieldEntry(field);
  if (fieldEntry?.valueType === 'iso_datetime') {
    const valueTime = typeof value === 'string' ? Date.parse(value) : Number.NaN;
    const argTime = typeof arg === 'string' ? Date.parse(arg) : Number.NaN;
    if (Number.isNaN(valueTime) || Number.isNaN(argTime)) {
      throw new Error(`Predicate ${predicate} requires ISO datetime strings for field ${field}`);
    }
    return predicate === 'gte' ? valueTime >= argTime : valueTime <= argTime;
  }

  const left = numericValue(value);
  const right = numericValue(arg);
  return predicate === 'gte' ? left >= right : left <= right;
}

function normalizePredicateArg(field: string, predicate: BrokerPredicateRequest['predicate'], arg: unknown): unknown {
  if (predicate === 'contains') {
    if (typeof arg !== 'string') throw new Error(`Predicate contains requires a string arg for field ${field}`);
    return normalizeFieldTerm(field, arg);
  }
  if (predicate === 'overlaps') {
    return normalizeSet(field, arg);
  }
  return normalizeScalar(arg);
}

function evaluatePredicate(
  field: string,
  value: unknown,
  predicate: BrokerPredicateRequest['predicate'],
  arg: unknown
): boolean {
  switch (predicate) {
    case 'eq':
      return normalizeScalar(value) === normalizeScalar(arg);
    case 'gte':
    case 'lte':
      return compareOrdered(field, value, arg, predicate);
    case 'is_empty':
      return isEmptyValue(value);
    case 'contains': {
      const normalizedArg = normalizePredicateArg(field, predicate, arg);
      const values = new Set(normalizeSet(field, value));
      return typeof normalizedArg === 'string' && values.has(normalizedArg);
    }
    case 'overlaps': {
      const declared = normalizePredicateArg(field, predicate, arg);
      const values = new Set(normalizeSet(field, value));
      return Array.isArray(declared) && declared.some((term) => values.has(String(term)));
    }
  }
}

function normalizePredicates(
  predicates: BrokerPredicateRequest | BrokerPredicateRequest[]
): BrokerPredicateRequest[] {
  return Array.isArray(predicates) ? predicates : [predicates];
}

export function brokerPredicateCacheKey(params: {
  subject: string;
  field: string;
  predicate: BrokerPredicateRequest['predicate'];
  arg: unknown;
}): string {
  const digest = hashJson(params);
  return `broker.predicate.${digest}`;
}

function dateToIso(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined;
  return value instanceof Date ? value.toISOString() : value;
}

function claimFromPayload(row: CachedAttestationRow): BrokerPredicateClaim | undefined {
  if (!row.payload || typeof row.payload !== 'object') return undefined;
  const payload = row.payload as Partial<BrokerPredicateClaim>;
  const predicate = payload.predicate;
  if (
    typeof payload.field !== 'string'
    || typeof predicate !== 'string'
    || !isBrokerPredicateName(predicate)
    || typeof payload.result !== 'boolean'
    || typeof payload.cacheKey !== 'string'
  ) {
    return undefined;
  }

  return {
    field: payload.field,
    predicate,
    result: payload.result,
    arg: payload.arg,
    valueHash: payload.valueHash,
    cacheKey: payload.cacheKey,
    cached: true,
    issuedAt: dateToIso(row.issued_at) ?? payload.issuedAt ?? new Date(0).toISOString(),
    expiresAt: dateToIso(row.expires_at) ?? payload.expiresAt ?? new Date(0).toISOString(),
  };
}

async function readCachedPredicateClaim(params: {
  subject: string;
  cacheKey: string;
}): Promise<BrokerPredicateClaim | undefined> {
  try {
    const { getClient } = await import('@imajin/db');
    const sql = getClient();
    const rows = await sql`
      SELECT id, payload, issued_at, expires_at
      FROM auth.attestations
      WHERE subject_did = ${params.subject}
        AND type = 'broker.release'
        AND context_id = ${params.cacheKey}
        AND context_type = 'broker.predicate'
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())
      ORDER BY issued_at DESC
      LIMIT 1
    `;
    const [row] = rows as CachedAttestationRow[];
    return row ? claimFromPayload(row) : undefined;
  } catch {
    return undefined;
  }
}

function assertPredicateAllowed(field: string, predicate: BrokerPredicateRequest['predicate']): void {
  if (!isBrokerPredicateName(predicate)) {
    throw new Error(`Unknown broker predicate ${String(predicate)}`);
  }
  if (!brokerPredicatesForField(field).includes(predicate)) {
    throw new Error(`Predicate ${predicate} is not allowed for broker field ${field}`);
  }
}

/**
 * Resolve the `contains(field, term)` under-primitive (#1514).
 *
 * This is the ONLY set predicate that is cached. Its cache key depends on a
 * single canonical term, so the warm set per subject is small, bounded, and
 * reusable across every requester who declares that term — which is what makes
 * a fixed vocabulary (#1444) pay for itself.
 */
async function resolveContainsPrimitive(options: {
  subject: string;
  field: string;
  value: unknown;
  term: string;
  now: Date;
  expiresAt: Date;
}): Promise<{ claim: BrokerPredicateClaim; fresh: boolean }> {
  const cacheKey = brokerPredicateCacheKey({
    subject: options.subject,
    field: options.field,
    predicate: 'contains',
    arg: options.term,
  });

  const cached = await readCachedPredicateClaim({ subject: options.subject, cacheKey });
  if (cached) return { claim: cached, fresh: false };

  return {
    fresh: true,
    claim: {
      field: options.field,
      predicate: 'contains',
      arg: options.term,
      result: evaluatePredicate(options.field, options.value, 'contains', options.term),
      valueHash: hashJson(options.value),
      cacheKey,
      issuedAt: options.now.toISOString(),
      expiresAt: options.expiresAt.toISOString(),
    },
  };
}

/**
 * Compose `overlaps(declaredSet, sovereignSet)` as a disjunction of cached
 * `contains` primitives (#1514).
 *
 * Every declared term is resolved through the warm `contains` cache and the
 * booleans are OR-ed. The composition itself is deliberately NOT cached: its
 * key would depend on the whole declared set, so every distinct dish/menu would
 * mint a new row and the cache would grow without ever being reused. Caching
 * the primitives instead means two requesters declaring overlapping sets share
 * every term they have in common.
 *
 * No short-circuit on the first `true`. Evaluating every term keeps the warm
 * set complete for the next requester and avoids leaking, through timing or
 * through the number of cache writes, which term produced the match.
 */
async function resolveOverlapsClaim(options: {
  subject: string;
  field: string;
  value: unknown;
  declaredArg: unknown;
  now: Date;
  expiresAt: Date;
}): Promise<{ claim: BrokerPredicateClaim; cacheWrites: BrokerPredicateClaim[] }> {
  // `contains` is the primitive `overlaps` is defined in terms of, so a field
  // that permits `overlaps` must also permit `contains`. The vocabulary pairs
  // them; this guards against a future entry that forgets to.
  assertPredicateAllowed(options.field, 'contains');

  const declaredTerms = [...new Set(normalizeSet(options.field, options.declaredArg))];
  const cacheWrites: BrokerPredicateClaim[] = [];
  const inputs: BrokerPredicateClaim[] = [];

  for (const term of declaredTerms) {
    const { claim, fresh } = await resolveContainsPrimitive({
      subject: options.subject,
      field: options.field,
      value: options.value,
      term,
      now: options.now,
      expiresAt: options.expiresAt,
    });
    inputs.push(claim);
    if (fresh) cacheWrites.push(claim);
  }

  return {
    cacheWrites,
    claim: {
      field: options.field,
      predicate: 'overlaps',
      arg: declaredTerms,
      result: inputs.some((input) => input.result),
      valueHash: hashJson(options.value),
      cacheKey: brokerPredicateCacheKey({
        subject: options.subject,
        field: options.field,
        predicate: 'overlaps',
        arg: declaredTerms,
      }),
      composedFrom: inputs.map((input) => input.cacheKey),
      issuedAt: options.now.toISOString(),
      expiresAt: options.expiresAt.toISOString(),
    },
  };
}

export async function resolveBrokerPredicateClaimsForField(
  options: PredicateClaimOptions
): Promise<BrokerPredicateResolution> {
  const now = options.now ?? new Date();
  const expiresAt = new Date(now.getTime() + DEFAULT_CLAIM_TTL_MS);
  const claims: BrokerPredicateClaim[] = [];
  const cacheWrites: BrokerPredicateClaim[] = [];

  for (const predicateRequest of normalizePredicates(options.predicates)) {
    const { predicate } = predicateRequest;
    assertPredicateAllowed(options.field, predicate);

    // `overlaps` composes over the warm `contains` cache rather than being
    // evaluated and cached as its own opaque claim.
    if (predicate === 'overlaps') {
      const composed = await resolveOverlapsClaim({
        subject: options.subject,
        field: options.field,
        value: options.value,
        declaredArg: predicateRequest.arg,
        now,
        expiresAt,
      });
      claims.push(composed.claim);
      cacheWrites.push(...composed.cacheWrites);
      continue;
    }

    const arg = normalizePredicateArg(options.field, predicate, predicateRequest.arg);
    const cacheKey = brokerPredicateCacheKey({
      subject: options.subject,
      field: options.field,
      predicate,
      arg,
    });
    const cached = await readCachedPredicateClaim({ subject: options.subject, cacheKey });
    if (cached) {
      claims.push(cached);
      continue;
    }

    const claim: BrokerPredicateClaim = {
      field: options.field,
      predicate,
      arg,
      result: evaluatePredicate(options.field, options.value, predicate, predicateRequest.arg),
      valueHash: hashJson(options.value),
      cacheKey,
      issuedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
    claims.push(claim);
    cacheWrites.push(claim);
  }

  return { claims, cacheWrites };
}
