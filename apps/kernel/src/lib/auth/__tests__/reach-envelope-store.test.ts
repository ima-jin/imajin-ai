import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { reachEnvelopes, reachSenderBlocks } from '@/src/db/schemas/reach';
import {
  blockReachSender,
  getReachEnvelope,
  listReachEnvelopes,
  markReachPublished,
  persistReachEnvelope,
  type PersistReachEnvelopeParams,
} from '../reach-envelope-store';

const mocked = vi.hoisted(() => ({ getClient: vi.fn() }));
vi.mock('@imajin/db', () => ({ getClient: mocked.getClient }));
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const migration = readFileSync(fileURLToPath(new URL(
  '../../../../../../migrations/0192_reach_envelopes.sql', import.meta.url,
)), 'utf8');

let database: PGlite;
let statements: Array<{ sql: string; params: unknown[]; transaction: boolean }>;
let failInsert = false;
let failAttestation = false;

function params(overrides: Partial<PersistReachEnvelopeParams> = {}): PersistReachEnvelopeParams {
  return {
    reachId: 'rch_1',
    principalDid: 'did:imajin:owner',
    requesterDid: 'did:imajin:sender',
    onBehalfOfStubDid: 'did:imajin:stub',
    onBehalfOf: { platform: 'foreign', externalRef: 'opaque-123', selfDescription: 'Unverified claim' },
    topic: 'collaboration',
    message: 'Private delivery, never audit content',
    replyHandle: 'opaque:reply-123',
    transcriptHash: 'hash-1',
    requesterSignature: 'requester-sig',
    requesterTier: 'established',
    grantId: 'grant-1',
    issuedAt: new Date().toISOString(),
    requestIssuedAt: new Date(Date.now() - 1000).toISOString(),
    signedEvent: { type: 'agent.reach.delivered', payload: { signature: { sig: 'signed-provenance' } } },
    dailyCap: 100,
    deliveryAttestation: {
      id: `att_reach_${overrides.reachId ?? 'rch_1'}`, issuerDid: 'did:imajin:node',
      subjectDid: overrides.principalDid ?? 'did:imajin:owner', type: 'agent.reach',
      contextId: overrides.reachId ?? 'rch_1', contextType: 'agent.reach',
      payload: { outcome: 'delivered', transcriptHash: overrides.transcriptHash ?? 'hash-1' },
      signature: 'signed-attestation', cid: null, attestationStatus: null, issuedAt: new Date(),
    },
    ...overrides,
  };
}

beforeAll(async () => {
  database = new PGlite();
  await database.waitReady;
  await database.exec(migration);
  await database.exec(`CREATE TABLE auth.attestations (
    id text PRIMARY KEY, issuer_did text NOT NULL, subject_did text NOT NULL,
    type text NOT NULL, context_id text, context_type text, payload jsonb,
    signature text NOT NULL, cid text, attestation_status text, issued_at timestamptz NOT NULL
  )`);
});

afterAll(async () => { await database?.close(); });

beforeEach(async () => {
  await database.exec('TRUNCATE auth.reach_envelopes, auth.reach_sender_blocks, auth.attestations');
  statements = [];
  failInsert = false;
  failAttestation = false;
  // The real engine evaluates every storage/count/isolation query. PGlite is
  // single-connection, so the advisory-lock call is recorded (not executed).
  // This asserts lock placement but does NOT prove multi-connection contention.
  function executor(target: Pick<PGlite, 'query'>, transaction: boolean) {
    return {
      async unsafe(sql: string, values: unknown[] = []) {
        statements.push({ sql, params: values, transaction });
        if (sql.includes('pg_advisory_xact_lock')) return [];
        if (failInsert && sql.includes('INSERT INTO auth.reach_envelopes')) throw new Error('insert failed');
        if (failAttestation && sql.includes('INSERT INTO auth.attestations')) throw new Error('attestation insert failed');
        return (await target.query(sql, values)).rows;
      },
    };
  }
  mocked.getClient.mockReturnValue({
    ...executor(database, false),
    begin: (isolation: string, fn: (tx: ReturnType<typeof executor>) => Promise<unknown>) => {
      expect(isolation).toBe('isolation level read committed');
      return database.transaction((tx) => fn(executor(tx, true)));
    },
  });
});

describe('reach envelope storage (#2588)', () => {
  it('declares delivery indexes and owner/sender block keys in the auth schema', () => {
    const envelopes = getTableConfig(reachEnvelopes);
    expect(envelopes.schema).toBe('auth');
    expect(envelopes.name).toBe('reach_envelopes');
    expect(envelopes.indexes.map((entry) => entry.config.name)).toEqual([
      'idx_reach_envelopes_replay', 'idx_reach_envelopes_principal_day', 'idx_reach_envelopes_sender_day',
    ]);
    expect(envelopes.indexes[0].config.unique).toBe(true);
    const blocks = getTableConfig(reachSenderBlocks);
    expect(blocks.schema).toBe('auth');
    expect(blocks.primaryKeys[0].columns.map((column) => column.name)).toEqual(['principal_did', 'requester_did']);
  });
  it('persists full private envelope and signed provenance with an explicitly unverified claim', async () => {
    const input = params();
    expect(await persistReachEnvelope(input)).toMatchObject({ stored: true, reachId: input.reachId });
    const expected: Partial<PersistReachEnvelopeParams> = { ...input };
    delete expected.dailyCap;
    delete expected.deliveryAttestation;
    expect(await getReachEnvelope(input)).toEqual({ ...expected, claimVerified: false });
    const write = statements.find(({ sql }) => sql.includes('INSERT INTO auth.reach_envelopes'));
    expect(write?.transaction).toBe(true);
    expect(statements[0]).toMatchObject({ transaction: true, params: [`reach:${input.principalDid}`] });
    expect(statements[0].sql).toContain('pg_advisory_xact_lock');
  });

  it('counts all principal deliveries across senders, not request-issued timestamps', async () => {
    await persistReachEnvelope(params({ dailyCap: 1, requestIssuedAt: '2000-01-01T00:00:00.000Z' }));
    expect(await persistReachEnvelope(params({
      reachId: 'rch_2', requesterDid: 'other', transcriptHash: 'hash-2', dailyCap: 1,
    }))).toEqual({ stored: false, reason: 'rate_limited' });
    expect(await listReachEnvelopes(params())).toHaveLength(1);
    expect(statements.filter(({ sql }) => sql.includes('count(*)')).every((s) => s.transaction)).toBe(true);
  });

  it('limits a sender to 25/day by default without consuming another sender or principal quota', async () => {
    for (let i = 0; i < 25; i++) {
      await persistReachEnvelope(params({ reachId: `rch_${i}`, transcriptHash: `hash-${i}` }));
    }
    expect(await persistReachEnvelope(params({ reachId: 'over', transcriptHash: 'over' })))
      .toEqual({ stored: false, reason: 'rate_limited' });
    expect(await persistReachEnvelope(params({ reachId: 'other-sender', requesterDid: 'other' })))
      .toMatchObject({ stored: true, reachId: 'other-sender' });
    expect(await persistReachEnvelope(params({ reachId: 'other-owner', principalDid: 'other-owner' })))
      .toMatchObject({ stored: true, reachId: 'other-owner' });
  });

  it('supports a lower sender cap and zero daily or sender caps', async () => {
    expect(await persistReachEnvelope(params({ dailyCap: 0 }))).toEqual({ stored: false, reason: 'rate_limited' });
    expect(await persistReachEnvelope(params({ perSenderDailyCap: 0 }))).toEqual({ stored: false, reason: 'rate_limited' });
    await persistReachEnvelope(params({ perSenderDailyCap: 1 }));
    expect(await persistReachEnvelope(params({ reachId: 'next', transcriptHash: 'next', perSenderDailyCap: 1 })))
      .toEqual({ stored: false, reason: 'rate_limited' });
  });

  it('allows a null principal cap while retaining the sender cap', async () => {
    await persistReachEnvelope(params({ dailyCap: null, perSenderDailyCap: 1 }));
    expect(await persistReachEnvelope(params({
      reachId: 'second', transcriptHash: 'second', dailyCap: null, perSenderDailyCap: 1,
    }))).toEqual({ stored: false, reason: 'rate_limited' });
    expect(await persistReachEnvelope(params({
      reachId: 'other', requesterDid: 'other', dailyCap: null, perSenderDailyCap: 1,
    }))).toMatchObject({ stored: true, reachId: 'other' });
  });

  it('returns original reachId on replay even after quota exhaustion, without replacing signed content', async () => {
    const original = params({ dailyCap: 1 });
    await persistReachEnvelope(original);
    expect(await persistReachEnvelope({
      ...original, reachId: 'replacement', message: 'do not overwrite',
      deliveryAttestation: { ...original.deliveryAttestation, id: 'att_reach_replacement' },
    }))
      .toMatchObject({ stored: true, reachId: original.reachId, replayed: true });
    expect((await getReachEnvelope(original))?.message).toBe(original.message);
    expect(await listReachEnvelopes(original)).toHaveLength(1);
  });

  it('blocks a sender durably and idempotently under the same principal lock, including replay attempts', async () => {
    const input = params();
    await persistReachEnvelope(input);
    await blockReachSender(input);
    await blockReachSender(input);
    expect(await persistReachEnvelope(input)).toEqual({ stored: false, reason: 'blocked' });
    expect(await persistReachEnvelope(params({ reachId: 'other', requesterDid: 'other' })))
      .toMatchObject({ stored: true, reachId: 'other' });
    expect(await persistReachEnvelope(params({ reachId: 'other-owner', principalDid: 'other-owner' })))
      .toMatchObject({ stored: true, reachId: 'other-owner' });
    const blockIndex = statements.findIndex(({ sql }) => sql.includes('INSERT INTO auth.reach_sender_blocks'));
    expect(statements[blockIndex - 1]).toMatchObject({ transaction: true, params: [`reach:${input.principalDid}`] });
    expect(statements[blockIndex - 1].sql).toContain('pg_advisory_xact_lock');
  });

  it('does not count previous UTC calendar-day deliveries in a non-UTC session', async () => {
    await database.exec("SET TIME ZONE 'Pacific/Honolulu'");
    try {
      await persistReachEnvelope(params({ dailyCap: 1 }));
      await database.exec(`UPDATE auth.reach_envelopes SET created_at =
        (date_trunc('day', statement_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') - interval '1 second'`);
      expect(await persistReachEnvelope(params({ reachId: 'today', transcriptHash: 'today', dailyCap: 1 })))
        .toMatchObject({ stored: true, reachId: 'today' });
    } finally {
      await database.exec("SET TIME ZONE 'UTC'");
    }
  });

  it('scopes get/list to the owner and orders/paginates deterministically', async () => {
    await persistReachEnvelope(params());
    await persistReachEnvelope(params({ reachId: 'rch_2', transcriptHash: 'hash-2' }));
    await persistReachEnvelope(params({ reachId: 'private-other', principalDid: 'other-owner' }));
    await database.exec("UPDATE auth.reach_envelopes SET created_at = '2026-01-01T00:00:00Z' WHERE reach_id = 'rch_1'");
    expect(await getReachEnvelope({ principalDid: 'other-owner', reachId: 'rch_1' })).toBeNull();
    expect((await listReachEnvelopes({ principalDid: 'did:imajin:owner', limit: 1 })).map((row) => row.reachId))
      .toEqual(['rch_2']);
    expect((await listReachEnvelopes({ principalDid: 'did:imajin:owner', limit: 1, offset: 1 })).map((row) => row.reachId))
      .toEqual(['rch_1']);
    expect(await listReachEnvelopes({ principalDid: 'unknown' })).toEqual([]);
  });

  it('rolls back failed inserts and propagates storage failure rather than claiming delivery', async () => {
    failInsert = true;
    await expect(persistReachEnvelope(params())).rejects.toThrow('insert failed');
    expect(await listReachEnvelopes(params())).toEqual([]);
  });

  it('replays migration safely and enforces uniqueness independently of application checks', async () => {
    await persistReachEnvelope(params());
    await database.exec(migration);
    expect(await listReachEnvelopes(params())).toHaveLength(1);
    await expect(database.query(`INSERT INTO auth.reach_envelopes
      (reach_id, principal_did, requester_did, transcript_hash, envelope, created_at)
      SELECT 'duplicate', principal_did, requester_did, transcript_hash, envelope, created_at
      FROM auth.reach_envelopes`)).rejects.toThrow('idx_reach_envelopes_replay');
  });

  it.each([-1, 1.5, Number.NaN, Infinity])('fails closed on invalid caps (%s)', async (cap) => {
    await expect(persistReachEnvelope(params({ dailyCap: cap }))).rejects.toThrow('caps');
    await expect(persistReachEnvelope(params({ perSenderDailyCap: cap }))).rejects.toThrow('caps');
    expect(statements).toHaveLength(0);
  });

  it('commits exactly one signed attestation with a delivery, and never another on replay', async () => {
    const input = params();
    await persistReachEnvelope(input);
    await persistReachEnvelope(input);
    const rows = await database.query('SELECT * FROM auth.attestations');
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      id: 'att_reach_rch_1', subject_did: input.principalDid, signature: 'signed-attestation',
      attestation_status: null, payload: input.deliveryAttestation.payload,
    });
    expect(statements.find(({ sql }) => sql.includes('INSERT INTO auth.attestations'))?.transaction).toBe(true);
  });

  it('rolls back the envelope when its attestation insert fails', async () => {
    failAttestation = true;
    await expect(persistReachEnvelope(params())).rejects.toThrow('attestation insert failed');
    expect(await listReachEnvelopes(params())).toEqual([]);
    expect((await database.query('SELECT * FROM auth.attestations')).rows).toEqual([]);
  });

  it('recovers the original pending signed event on retry and marks publication owner-scoped/idempotently', async () => {
    const original = params();
    expect(await persistReachEnvelope(original)).toMatchObject({
      published: false, signedEvent: original.signedEvent,
    });
    const retry = params({ reachId: 'replacement', signedEvent: { different: 'must not replace original' } });
    expect(await persistReachEnvelope(retry)).toMatchObject({
      replayed: true, reachId: original.reachId, published: false, signedEvent: original.signedEvent,
    });
    await markReachPublished({ principalDid: 'wrong-owner', reachId: original.reachId });
    expect(await persistReachEnvelope(original)).toMatchObject({ published: false });
    await markReachPublished(original);
    const firstMark = await database.query('SELECT published_at FROM auth.reach_envelopes');
    await markReachPublished(original);
    expect(await database.query('SELECT published_at FROM auth.reach_envelopes')).toEqual(firstMark);
    expect(await persistReachEnvelope(original)).toMatchObject({
      published: true, replayed: true, signedEvent: original.signedEvent,
    });
  });

  it('rejects an unrelated prepared attestation before writing', async () => {
    const input = params();
    input.deliveryAttestation.subjectDid = 'other-owner';
    await expect(persistReachEnvelope(input)).rejects.toThrow('bind');
    expect(statements).toHaveLength(0);
  });

  it('rejects invalid pagination without running a query', async () => {
    await expect(listReachEnvelopes({ principalDid: 'owner', limit: Number.NaN })).rejects.toThrow('pagination');
    await expect(listReachEnvelopes({ principalDid: 'owner', offset: Infinity })).rejects.toThrow('pagination');
    expect(statements).toHaveLength(0);
  });
});
