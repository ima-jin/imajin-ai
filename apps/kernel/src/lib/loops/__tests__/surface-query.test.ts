import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const { calls, fakeSql, queue } = vi.hoisted(() => {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const queue: unknown[][] = [];
  return { calls, queue, fakeSql: vi.fn() };
});
vi.mock('@imajin/db', () => ({ getClient: () => fakeSql }));

import { listLoopSurfaces } from '../surface-query';

const PRINCIPAL = 'did:imajin:owner';
const timestamp = '2026-10-16T12:00:00.000Z';
const signature = { keyId: 'key', alg: 'ed25519', sig: 'signed' };
const signedPayload = { loopId: 'loop_holder', surface: 'repo:ima-jin/imajin-ai#branch:main', at: timestamp };

function rawLease(overrides: Record<string, unknown> = {}) {
  return {
    surface: signedPayload.surface,
    loop_id: 'loop_holder',
    principal: PRINCIPAL,
    issuer: 'did:imajin:agent',
    signature,
    signed_payload: signedPayload,
    acquired_at: new Date(timestamp),
    expires_at: '2026-10-16T08:15:00-04:00',
    heartbeat_at: timestamp,
    released_at: null,
    updated_at: new Date(timestamp),
    ...overrides,
  };
}

function rawConflict(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt_conflict',
    loop_id: 'loop_claimant',
    type: 'surface.conflicted',
    issuer: 'did:imajin:witness',
    principal: PRINCIPAL,
    payload: {
      loopId: 'loop_claimant',
      surface: signedPayload.surface,
      refs: { conflictingLoopId: 'loop_holder' },
      at: timestamp,
      summary: 'warn only',
      signature,
    },
    occurred_at: new Date(timestamp),
    created_at: '2026-10-16T08:00:00-04:00',
    ...overrides,
  };
}

beforeEach(() => {
  calls.length = 0;
  queue.length = 0;
  fakeSql.mockReset();
  fakeSql.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join(' ? '), values });
    return Promise.resolve(queue.shift() ?? []);
  });
});

describe('listLoopSurfaces', () => {
  it('scopes both reads to principal, excludes expired/released leases, and bounds both reads', async () => {
    expect(await listLoopSurfaces({ principal: PRINCIPAL })).toEqual({
      leases: [], conflicts: [], warnOnly: true,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0].text).toContain('FROM kernel.surface_lease');
    expect(calls[0].text).toContain('WHERE principal =');
    expect(calls[0].text).toContain('AND released_at IS NULL');
    expect(calls[0].text).toContain('AND expires_at > now()');
    expect(calls[0].values).toEqual([PRINCIPAL, null, null, 50]);
    expect(calls[1].text).toContain('WHERE principal =');
    expect(calls[1].text).toContain("AND type = 'surface.conflicted'");
    expect(calls[1].values).toEqual([PRINCIPAL, null, null, null, 50]);
  });

  it('filters holder leases and claimant OR holder conflict payloads without broadening principal scope', async () => {
    await listLoopSurfaces({ principal: PRINCIPAL, loopId: 'loop_holder', limit: 7 });
    expect(calls[0].text).toContain('OR loop_id =');
    expect(calls[0].values).toEqual([PRINCIPAL, 'loop_holder', 'loop_holder', 7]);
    expect(calls[1].text).toContain("OR payload->>'loopId' =");
    expect(calls[1].text).toContain("OR payload->'refs'->>'conflictingLoopId' =");
    expect(calls[1].values).toEqual([PRINCIPAL, 'loop_holder', 'loop_holder', 'loop_holder', 7]);
  });

  it.each([
    [undefined, 50], [Number.NaN, 50], [Number.POSITIVE_INFINITY, 50],
    [0, 50], [-1, 50], [0.9, 50], [1, 1], [12.9, 12], [200, 200], [2000, 200],
  ])('bounds limit %s to %s for each read', async (limit, expected) => {
    await listLoopSurfaces({ principal: PRINCIPAL, limit });
    for (const call of calls) expect(call.values.at(-1)).toBe(expected);
  });

  it('serializes every lease field and conflict event timestamps while retaining signed evidence', async () => {
    const conflict = rawConflict();
    queue.push([rawLease()], [conflict]);
    const result = await listLoopSurfaces({ principal: PRINCIPAL });
    expect(result).toEqual({
      leases: [{
        surface: signedPayload.surface, loopId: 'loop_holder', principal: PRINCIPAL,
        issuer: 'did:imajin:agent', signature, signedPayload,
        acquiredAt: timestamp, expiresAt: '2026-10-16T12:15:00.000Z',
        heartbeatAt: timestamp, releasedAt: null, updatedAt: timestamp,
      }],
      conflicts: [{
        id: 'evt_conflict', loopId: 'loop_claimant', type: 'surface.conflicted',
        issuer: 'did:imajin:witness', principal: PRINCIPAL, payload: conflict.payload,
        occurredAt: timestamp, createdAt: timestamp,
      }],
      warnOnly: true,
    });
  });

  it('normalizes string timestamp inputs and optional release evidence', async () => {
    queue.push([rawLease({
      acquired_at: '2026-10-16T08:00:00-04:00',
      released_at: new Date(timestamp),
    })], []);
    const result = await listLoopSurfaces({ principal: PRINCIPAL, loopId: '' });
    expect(result.leases[0].acquiredAt).toBe(timestamp);
    expect(result.leases[0].releasedAt).toBe(timestamp);
    expect(calls[0].values).toEqual([PRINCIPAL, null, null, 50]);
  });
});

describe('surface queries executed against PostgreSQL semantics', () => {
  it('enforces expiry, release, principal isolation, two-sided conflict filtering, and independent limits', async () => {
    const db = new PGlite();
    try {
      await db.exec(`
        CREATE SCHEMA kernel;
        CREATE TABLE kernel.surface_lease (
          surface text PRIMARY KEY, loop_id text, principal text, issuer text,
          signature jsonb, signed_payload jsonb, acquired_at timestamptz,
          expires_at timestamptz, heartbeat_at timestamptz, released_at timestamptz,
          updated_at timestamptz
        );
        CREATE TABLE kernel.loop_events (
          id text PRIMARY KEY, loop_id text, type text, issuer text,
          principal text, payload jsonb, occurred_at timestamptz, created_at timestamptz
        );
        INSERT INTO kernel.surface_lease
          (surface, loop_id, principal, issuer, signature, signed_payload, acquired_at,
           expires_at, heartbeat_at, released_at, updated_at)
        SELECT surface, loop_id, principal, 'did:imajin:agent', '{}', '{}', now(),
               expires_at, now(), released_at, now()
        FROM (VALUES
          ('live-a', 'holder', '${PRINCIPAL}', now() + interval '1 hour', NULL::timestamptz),
          ('live-b', 'holder', '${PRINCIPAL}', now() + interval '1 hour', NULL::timestamptz),
          ('expired', 'holder', '${PRINCIPAL}', now() - interval '1 second', NULL::timestamptz),
          ('released', 'holder', '${PRINCIPAL}', now() + interval '1 hour', now()),
          ('other-principal', 'holder', 'did:imajin:other', now() + interval '1 hour', NULL::timestamptz),
          ('other-loop', 'unrelated', '${PRINCIPAL}', now() + interval '1 hour', NULL::timestamptz)
        ) AS leases(surface, loop_id, principal, expires_at, released_at);
      `);
      const events = [
        ['claimant', PRINCIPAL, 'surface.conflicted', 'holder', 'other'],
        ['holder', PRINCIPAL, 'surface.conflicted', 'claimant', 'holder'],
        ['unrelated', PRINCIPAL, 'surface.conflicted', 'unrelated', 'different'],
        ['foreign', 'did:imajin:other', 'surface.conflicted', 'holder', 'holder'],
        ['progress', PRINCIPAL, 'loop.progress', 'holder', 'holder'],
      ];
      for (const [id, principal, type, loopId, conflictingLoopId] of events) {
        await db.query(
          `INSERT INTO kernel.loop_events VALUES ($1,$2,$3,'issuer',$4,$5::jsonb,now(),now())`,
          [id, loopId, type, principal, JSON.stringify({ loopId, refs: { conflictingLoopId } })],
        );
      }
      fakeSql.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const text = strings.reduce((query, part, index) => (
          query + (index ? `$${index}` : '') + part
        ), '');
        return (await db.query(text, values)).rows;
      });

      const filtered = await listLoopSurfaces({ principal: PRINCIPAL, loopId: 'holder' });
      expect(filtered.leases.map((lease) => lease.surface)).toEqual(['live-a', 'live-b']);
      expect(filtered.conflicts.map((event) => event.id).sort()).toEqual(['claimant', 'holder']);
      const all = await listLoopSurfaces({ principal: PRINCIPAL });
      expect(all.leases.map((lease) => lease.surface).sort()).toEqual(['live-a', 'live-b', 'other-loop']);
      expect(all.conflicts.map((event) => event.id).sort()).toEqual(['claimant', 'holder', 'unrelated']);
      const limited = await listLoopSurfaces({ principal: PRINCIPAL, loopId: 'holder', limit: 1 });
      expect(limited.leases).toHaveLength(1);
      expect(limited.conflicts).toHaveLength(1);
      const missing = await listLoopSurfaces({ principal: 'did:imajin:nobody', loopId: 'holder' });
      expect(missing).toEqual({ leases: [], conflicts: [], warnOnly: true });
    } finally {
      await db.close();
    }
  });
});
