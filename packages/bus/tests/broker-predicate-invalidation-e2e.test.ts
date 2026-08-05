/**
 * End-to-end cache lifecycle for the broker predicate cache (#1517, #1515).
 *
 * Unlike `broker-predicate-invalidation.test.ts`, which asserts the reactor's
 * SQL in isolation, this exercises the whole cycle against a stateful in-memory
 * stand-in for `auth.attestations`:
 *
 *   broker() → mint + cache a claim
 *   broker() → serve it from cache (no re-evaluation)
 *   profile.field.changed → reactor revokes the cached claim
 *   broker() → cache miss → re-evaluate against the NEW value → re-cache
 *
 * A claim stops being usable by either of two INDEPENDENT mechanisms, both
 * covered here: explicit revocation (`revoked_at`, driven by a field change) and
 * self-expiry (`expires_at` lapsing, the TTL backstop for changes nothing
 * announced). The expiry path is #1515's remaining requirement.
 *
 * The `emitAttestation` mock writes into the same in-memory table the cache read
 * path queries, so the persistence hop is real rather than assumed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

interface AttestationRow {
  subject_did: string;
  type: string;
  context_id: string;
  context_type: string;
  payload: Record<string, unknown>;
  issued_at: string;
  expires_at: string | null;
  revoked_at: string | null;
}

const { rows, fakeSql } = vi.hoisted(() => {
  const rows: AttestationRow[] = [];

  const fakeSql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(' ? ');

    // Broker chain config: none, so broker() uses its built-in default chain.
    if (text.includes('bus_chain_configs')) return Promise.resolve([]);

    // Consent: allergies granted to the restaurant in attestation mode.
    if (text.includes('consent_grants')) {
      if (text.includes('granted_to_class')) return Promise.resolve([]);
      return Promise.resolve([{
        allowed_fields: ['allergies'],
        mode: 'attestation',
        consent_ref: 'consent-traveler-allergies',
        granted_to: 'did:imajin:restaurant',
        purpose: 'restaurant_reservation',
      }]);
    }

    // Audit log writes are irrelevant here.
    if (text.includes('broker_audit_log')) return Promise.resolve([]);

    // Invalidation: revoke live predicate claims for the changed fields.
    if (text.includes('UPDATE auth.attestations')) {
      const [subject, fields] = values as [string, string[]];
      for (const row of rows) {
        if (
          row.subject_did === subject
          && row.context_type === 'broker.predicate'
          && row.revoked_at === null
          && fields.includes(String(row.payload.field))
        ) {
          row.revoked_at = new Date().toISOString();
        }
      }
      return Promise.resolve([]);
    }

    // Cache read: live (non-revoked, non-expired) claim for this cache key.
    if (text.includes('FROM auth.attestations')) {
      const [subject, cacheKey] = values as [string, string];
      const now = Date.now();
      const match = rows.find((row) => (
        row.subject_did === subject
        && row.context_id === cacheKey
        && row.context_type === 'broker.predicate'
        && row.revoked_at === null
        && (row.expires_at === null || Date.parse(row.expires_at) > now)
      ));
      return Promise.resolve(match ? [match] : []);
    }

    return Promise.resolve([]);
  };

  return { rows, fakeSql };
});

vi.mock('@imajin/db', () => ({ getClient: () => fakeSql }));

// The attestation emitter persists into the same table the cache reads from.
vi.mock('@imajin/auth', () => ({
  emitAttestation: vi.fn(async (params: {
    subject_did: string;
    type: string;
    context_id: string;
    context_type: string;
    payload?: Record<string, unknown>;
    expires_at?: string;
  }) => {
    rows.push({
      subject_did: params.subject_did,
      type: params.type,
      context_id: params.context_id,
      context_type: params.context_type,
      payload: params.payload ?? {},
      issued_at: new Date().toISOString(),
      expires_at: params.expires_at ?? null,
      revoked_at: null,
    });
  }),
}));

vi.mock('../src/publish', () => ({ publish: vi.fn().mockResolvedValue(undefined) }));

import { broker } from '../src/broker';
import { brokerPredicateCacheKey } from '../src/predicate-claims';
import { brokerPredicateInvalidationReactor } from '../src/reactors/broker-predicate-invalidation';
import { isBrokerRelease, type BrokerPredicateClaim } from '../src/types';

const TRAVELER = 'did:imajin:traveler';
const RESTAURANT = 'did:imajin:restaurant';

const PEANUT_CACHE_KEY = brokerPredicateCacheKey({
  subject: TRAVELER,
  field: 'allergies',
  predicate: 'contains',
  arg: 'peanut',
});

/** Ask "does this traveler's allergy set contain peanut?" against a given value. */
async function askPeanut(allergies: string): Promise<BrokerPredicateClaim> {
  const result = await broker('profile.field.request', {
    type: 'profile.field.request',
    requester: RESTAURANT,
    subject: TRAVELER,
    fields: ['allergies'],
    purpose: 'restaurant_reservation',
    scope: 'tripian',
    data: { allergies },
    predicates: { allergies: { predicate: 'contains', arg: 'peanut' } },
  });

  if (!isBrokerRelease(result)) {
    throw new Error(`expected a release, got ${result.status}: ${result.details ?? ''}`);
  }
  return result.data.allergies as BrokerPredicateClaim;
}

/**
 * Every predicate cache row, live or not. Excludes the release-level
 * `broker.release` attestation, which lands in the same table but is an audit
 * record rather than a cache entry.
 */
function predicateRows(): AttestationRow[] {
  return rows.filter((row) => row.context_type === 'broker.predicate');
}

/**
 * Cache rows the broker would actually accept: neither revoked nor expired.
 * Mirrors the read path's own liveness predicate, so "live" here means the same
 * thing it means in SQL.
 */
function livePredicateRows(): AttestationRow[] {
  const now = Date.now();
  return rows.filter((row) => (
    row.context_type === 'broker.predicate'
    && row.revoked_at === null
    && (row.expires_at === null || Date.parse(row.expires_at) > now)
  ));
}

/**
 * Write a predicate cache row directly, as a previous release would have left
 * one behind. `expiresAt` in the past produces a lapsed row.
 */
function seedPeanutClaim(options: { result: boolean; expiresAt: Date; revokedAt?: Date }): void {
  rows.push({
    subject_did: TRAVELER,
    type: 'broker.release',
    context_id: PEANUT_CACHE_KEY,
    context_type: 'broker.predicate',
    payload: {
      field: 'allergies',
      predicate: 'contains',
      arg: 'peanut',
      result: options.result,
      valueHash: 'seeded',
      cacheKey: PEANUT_CACHE_KEY,
      issuedAt: new Date(options.expiresAt.getTime() - 60 * 60 * 1000).toISOString(),
      expiresAt: options.expiresAt.toISOString(),
    },
    issued_at: new Date(options.expiresAt.getTime() - 60 * 60 * 1000).toISOString(),
    expires_at: options.expiresAt.toISOString(),
    revoked_at: options.revokedAt?.toISOString() ?? null,
  });
}

function hoursFromNow(hours: number): Date {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

async function mutateAllergies(): Promise<void> {
  await brokerPredicateInvalidationReactor({
    type: 'profile.field.changed',
    issuer: TRAVELER,
    subject: TRAVELER,
    scope: 'profile',
    payload: {
      subjectDid: TRAVELER,
      fields: ['allergies'],
      context_id: TRAVELER,
      context_type: 'profile',
    },
  }, {});
}

beforeEach(() => {
  rows.length = 0;
  vi.clearAllMocks();
});

describe('predicate cache invalidation (end to end)', () => {
  it('mutating a field invalidates dependent claims so the next request re-evaluates and re-caches', async () => {
    // 1. First request: nothing cached, so the claim is evaluated and persisted.
    const first = await askPeanut('peanuts; shellfish');
    expect(first.result).toBe(true);
    expect(first.cached).toBeUndefined();
    expect(livePredicateRows()).toHaveLength(1);

    // 2. Second request with the same value: served from the warm cache.
    const second = await askPeanut('peanuts; shellfish');
    expect(second.cached).toBe(true);
    expect(second.result).toBe(true);
    // Still exactly one cache row — a cache hit must not mint a duplicate.
    expect(livePredicateRows()).toHaveLength(1);

    // 3. The traveler removes peanut from their allergy set.
    await mutateAllergies();

    // The previously cached claim is revoked, not left live.
    expect(livePredicateRows()).toHaveLength(0);
    expect(rows.filter((row) => row.revoked_at !== null)).toHaveLength(1);

    // 4. Next request re-evaluates against the NEW value and re-caches.
    const third = await askPeanut('shellfish');
    expect(third.cached).toBeUndefined();
    expect(third.result).toBe(false);

    const live = livePredicateRows();
    expect(live).toHaveLength(1);
    expect(live[0].payload.result).toBe(false);

    // Critically: the stale `true` never resurfaces after the mutation.
    const fourth = await askPeanut('shellfish');
    expect(fourth.cached).toBe(true);
    expect(fourth.result).toBe(false);
  });

  it('leaves claims for other fields untouched when one field changes', async () => {
    await askPeanut('peanuts');
    expect(livePredicateRows()).toHaveLength(1);

    // A change to an unrelated field must not revoke the allergies claim.
    await brokerPredicateInvalidationReactor({
      type: 'profile.field.changed',
      issuer: TRAVELER,
      subject: TRAVELER,
      scope: 'profile',
      payload: {
        subjectDid: TRAVELER,
        fields: ['displayName'],
        context_id: TRAVELER,
        context_type: 'profile',
      },
    }, {});

    expect(livePredicateRows()).toHaveLength(1);
    const stillCached = await askPeanut('peanuts');
    expect(stillCached.cached).toBe(true);
  });

  it('does not invalidate another subject\u2019s cached claims', async () => {
    await askPeanut('peanuts');

    await brokerPredicateInvalidationReactor({
      type: 'profile.field.changed',
      issuer: 'did:imajin:someone-else',
      subject: 'did:imajin:someone-else',
      scope: 'profile',
      payload: {
        subjectDid: 'did:imajin:someone-else',
        fields: ['allergies'],
        context_id: 'did:imajin:someone-else',
        context_type: 'profile',
      },
    }, {});

    expect(livePredicateRows()).toHaveLength(1);
  });
});

// ── #1515: the expiry path ────────────────────────────────────────────────
//
// Revocation handles changes the platform knows about. Expiry is the backstop for
// everything else — a value mutated by a path that never emitted an event, or a
// claim simply old enough that it should be re-derived rather than trusted.

describe('predicate cache expiry (end to end)', () => {
  it('ignores a lapsed claim, re-evaluates against the current value, and re-caches', async () => {
    // A claim that answered `true` an hour ago and has since lapsed. It is NOT
    // revoked — expiry alone must be enough to stop it being served.
    seedPeanutClaim({ result: true, expiresAt: hoursFromNow(-1) });
    expect(predicateRows()).toHaveLength(1);
    expect(livePredicateRows()).toHaveLength(0);

    // The traveler's set no longer contains peanut, so the honest answer is now
    // `false`. Serving the lapsed row would return the stale `true`.
    const claim = await askPeanut('shellfish');

    expect(claim.cached).toBeUndefined();
    expect(claim.result).toBe(false);

    // Re-cached: a fresh row with a future expiry, alongside the lapsed one.
    const live = livePredicateRows();
    expect(live).toHaveLength(1);
    expect(live[0].payload.result).toBe(false);
    expect(live[0].expires_at).not.toBeNull();
    expect(Date.parse(String(live[0].expires_at))).toBeGreaterThan(Date.now());

    // The follow-up request is a hit on the row just written, not a third eval.
    const next = await askPeanut('shellfish');
    expect(next.cached).toBe(true);
    expect(next.result).toBe(false);
    expect(livePredicateRows()).toHaveLength(1);
  });

  it('serves a claim that is still within its TTL', async () => {
    // Same seeded shape, still live. Contradicts the current value on purpose:
    // `true` coming back proves the cached row was used rather than re-derived.
    seedPeanutClaim({ result: true, expiresAt: hoursFromNow(1) });

    const claim = await askPeanut('shellfish');

    expect(claim.cached).toBe(true);
    expect(claim.result).toBe(true);
    // Nothing new minted — a live row must not be duplicated.
    expect(predicateRows()).toHaveLength(1);
  });

  it('treats expiry and revocation as independent — either one is disqualifying', async () => {
    // Revoked but not yet expired.
    seedPeanutClaim({ result: true, expiresAt: hoursFromNow(1), revokedAt: new Date() });

    const claim = await askPeanut('shellfish');
    expect(claim.cached).toBeUndefined();
    expect(claim.result).toBe(false);
  });

  it('persists every minted claim with a TTL so it can lapse on its own', async () => {
    await askPeanut('peanuts');

    const [minted] = predicateRows();
    expect(minted.expires_at).not.toBeNull();
    expect(Date.parse(String(minted.expires_at))).toBeGreaterThan(Date.parse(minted.issued_at));
  });
});
