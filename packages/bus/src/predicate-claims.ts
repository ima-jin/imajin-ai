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

export async function resolveBrokerPredicateClaimsForField(
  options: PredicateClaimOptions
): Promise<BrokerPredicateClaim[]> {
  const now = options.now ?? new Date();
  const expiresAt = new Date(now.getTime() + DEFAULT_CLAIM_TTL_MS);
  const claims: BrokerPredicateClaim[] = [];

  for (const predicateRequest of normalizePredicates(options.predicates)) {
    const { predicate } = predicateRequest;
    assertPredicateAllowed(options.field, predicate);
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

    claims.push({
      field: options.field,
      predicate,
      arg,
      result: evaluatePredicate(options.field, options.value, predicate, predicateRequest.arg),
      valueHash: hashJson(options.value),
      cacheKey,
      issuedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });
  }

  return claims;
}
