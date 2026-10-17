import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { reachStatus } from '../reach-status';

const mocked = vi.hoisted(() => ({ getClient: vi.fn() }));
vi.mock('@imajin/db', () => ({ getClient: mocked.getClient }));
vi.setConfig({ hookTimeout: 30_000, testTimeout: 30_000 });

let database: PGlite;
const principalDid = 'did:imajin:ryan';
const requesterDid = 'did:imajin:stranger';
const reply = { type: 'agent.reach.replied', payload: { message: 'Hello', signature: { sig: 'principal-proof' } } };
const params = { principalDid, requesterDid, reachId: 'reach_1' };

beforeAll(async () => {
  database = new PGlite();
  await database.exec(readFileSync(new URL('../../../../../../migrations/0195_reach_envelopes.sql', import.meta.url), 'utf8'));
  mocked.getClient.mockReturnValue({
    unsafe: async (sql: string, values: unknown[]) => (await database.query(sql, values)).rows,
  });
});
afterAll(async () => { await database.close(); });
beforeEach(async () => {
  await database.exec('TRUNCATE auth.reach_envelopes, auth.reach_sender_blocks');
  await database.query(`
    INSERT INTO auth.reach_envelopes (reach_id, principal_did, requester_did, transcript_hash, envelope)
    VALUES ($1, $2, $3, 'hash', $4::jsonb)
  `, [params.reachId, principalDid, requesterDid, JSON.stringify({ message: 'private original', replyHandle: 'opaque', reply })]);
});

describe('requester-scoped reach_status', () => {
  it('returns the signed reply without private delivery content', async () => {
    expect(await reachStatus(params)).toEqual({ reachId: params.reachId, state: 'replied', reply });
  });

  it.each([
    { requesterDid: 'did:imajin:unrelated' },
    { principalDid: 'did:imajin:unrelated' },
    { reachId: 'unknown' },
  ])('does not treat a reach id as a read capability: %j', async (override) => {
    expect(await reachStatus({ ...params, ...override })).toBeNull();
  });

  it('returns a delivered state before the principal replies', async () => {
    await database.exec("UPDATE auth.reach_envelopes SET envelope = envelope - 'reply'");
    expect(await reachStatus(params)).toEqual({ reachId: params.reachId, state: 'delivered', reply: null });
  });

  it('withholds an existing reply after the principal blocks its sender', async () => {
    await database.query('INSERT INTO auth.reach_sender_blocks (principal_did, requester_did) VALUES ($1, $2)', [principalDid, requesterDid]);
    expect(await reachStatus(params)).toEqual({ reachId: params.reachId, state: 'blocked', reply: null });
  });
});
