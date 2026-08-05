/**
 * End-to-end invalidation loop for #1517.
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
import { brokerPredicateInvalidationReactor } from '../src/reactors/broker-predicate-invalidation';
import { isBrokerRelease, type BrokerPredicateClaim } from '../src/types';

const TRAVELER = 'did:imajin:traveler';
const RESTAURANT = 'did:imajin:restaurant';

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

function livePredicateRows(): AttestationRow[] {
  return rows.filter((row) => row.context_type === 'broker.predicate' && row.revoked_at === null);
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
