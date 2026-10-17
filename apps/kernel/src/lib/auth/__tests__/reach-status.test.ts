import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { reachStatus } from '../reach-status';
import { didFromPublicKey } from '../crypto';

const mocked = vi.hoisted(() => ({ getClient: vi.fn() }));
vi.mock('@imajin/db', () => ({ getClient: mocked.getClient }));
vi.setConfig({ hookTimeout: 30_000, testTimeout: 30_000 });

let database: PGlite;
const principalDid = 'did:imajin:ryan';
const requesterDid = 'did:imajin:stranger';
const reply = { type: 'agent.reach.replied', payload: { message: 'Hello', signature: { sig: 'principal-proof' } } };
const params = { principalDid, requesterDid, reachId: 'reach_1' };
const claimedDid = 'did:imajin:claimed-human';
const senderKey = 'ef'.repeat(32);
const stubDid = 'did:imajin:foreign-stub';

beforeAll(async () => {
  database = new PGlite();
  await database.exec(readFileSync(new URL('../../../../../../migrations/0195_reach_envelopes.sql', import.meta.url), 'utf8'));
  await database.exec('CREATE TABLE auth.identities (id text PRIMARY KEY)');
  await database.exec(readFileSync(new URL('../../../../../../migrations/0198_foreign_agent_stubs.sql', import.meta.url), 'utf8'));
  mocked.getClient.mockReturnValue({
    unsafe: async (sql: string, values: unknown[]) => (await database.query(sql, values)).rows,
  });
});
afterAll(async () => { await database.close(); });
beforeEach(async () => {
  await database.exec('TRUNCATE auth.reach_envelopes, auth.reach_sender_blocks, auth.foreign_agent_stubs, auth.identities');
  await database.query('INSERT INTO auth.identities (id) VALUES ($1), ($2)', [principalDid, stubDid]);
  await database.query(`INSERT INTO auth.foreign_agent_stubs
    (stub_did, principal_did, requester_did, signer_key, requester_aliases)
    VALUES ($1, $2, $3, $4, $5::jsonb)`,
  [stubDid, principalDid, requesterDid, senderKey, JSON.stringify(['did:web:alias.example'])]);
  await database.query(`
    INSERT INTO auth.reach_envelopes (reach_id, principal_did, requester_did, transcript_hash, envelope)
    VALUES ($1, $2, $3, 'hash', $4::jsonb)
  `, [params.reachId, principalDid, requesterDid, JSON.stringify({
    message: 'private original', replyHandle: 'opaque', onBehalfOfStubDid: claimedDid, reply,
  })]);
});

describe('linked identity receipt blocks', () => {
  it.each([claimedDid, stubDid, 'did:web:alias.example', didFromPublicKey(senderKey)])(
    'withholds an existing reply when the owner blocked linked identity %s', async (blockedDid) => {
      await database.query('INSERT INTO auth.reach_sender_blocks (principal_did, requester_did) VALUES ($1, $2)', [principalDid, blockedDid]);
      expect(await reachStatus(params)).toEqual({ reachId: params.reachId, state: 'blocked', reply: null });
    },
  );

  it('does not apply another recipient’s alias or claimed-principal blocks', async () => {
    for (const blockedDid of [requesterDid, claimedDid, stubDid, 'did:web:alias.example', didFromPublicKey(senderKey)]) {
      await database.query('INSERT INTO auth.reach_sender_blocks (principal_did, requester_did) VALUES ($1, $2)', ['other-owner', blockedDid]);
    }
    expect(await reachStatus(params)).toEqual({ reachId: params.reachId, state: 'replied', reply });
  });

  it('withholds replies for a revoked foreign credential even without a block-list row', async () => {
    await database.exec('UPDATE auth.foreign_agent_stubs SET revoked_at = now()');
    expect(await reachStatus(params)).toEqual({ reachId: params.reachId, state: 'blocked', reply: null });
  });

  it('never resolves a receipt by a matching foreign alias instead of its authenticated requester', async () => {
    expect(await reachStatus({ ...params, requesterDid: 'did:web:alias.example' })).toBeNull();
    expect(await reachStatus({ ...params, requesterDid: stubDid })).toBeNull();
  });
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
