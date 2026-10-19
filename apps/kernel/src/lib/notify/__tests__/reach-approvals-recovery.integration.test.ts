import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { operatorApprovals } from '@/src/db/schemas/operator-approvals';
import type { ReachEnvelope } from '@/src/db/schemas/reach';
import type { KnockRecord } from '../../auth/knock';
import { OPERATOR_APPROVALS_TABLE_SQL } from '../../jin/__tests__/pglite-record-events-harness';
import { backfillReachApprovals, knockCardFields, reachCardFields } from '../reach-approvals';
import { computeApprovalContentHash } from '../operator-approvals';
import { pushWebNotificationToOperator } from '../web-push';

const state = vi.hoisted(() => ({ db: null as unknown, sql: null as unknown }));
vi.mock('@imajin/db', () => ({ getClient: () => state.sql }));
vi.mock('@/src/db', async () => ({
  ...await import('@/src/db/schemas/auth'),
  ...await import('@/src/db/schemas/operator-approvals'),
  get db() { return state.db; },
}));
vi.mock('@imajin/bus', () => ({ publish: vi.fn() }));
vi.mock('../web-push', () => ({ pushWebNotificationToOperator: vi.fn().mockResolvedValue(undefined) }));
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let client: PGlite;
let queries: string[];
const principalDid = 'did:imajin:recovery-owner';
const otherDid = 'did:imajin:other-owner';

function envelope(index: number, owner = principalDid): ReachEnvelope {
  return {
    reachId: `r-${index}`, principalDid: owner, requesterDid: `did:imajin:sender-${index}`,
    requesterTier: 'reach-only', onBehalfOfStubDid: `stub-${index}`,
    onBehalfOf: { platform: 'test', externalRef: `external-${index}` }, claimVerified: false,
    topic: 'general', message: `Message ${index}`, transcriptHash: `transcript-${index}`,
    replyHandle: 'private-reply-handle', requesterSignature: 'signature', grantId: null,
    issuedAt: new Date().toISOString(), requestIssuedAt: new Date().toISOString(), signedEvent: {},
  };
}

function knock(index: number, overrides: Partial<KnockRecord> = {}): KnockRecord {
  return {
    knockId: `k-${index}`, agentDid: `did:imajin:knocker-${index}`, declaredTarget: principalDid,
    selfDescription: `Knock ${index}`, requestedCapabilities: ['chat:read'], externalDid: null,
    externalDidVerification: null, externalDidVerifiedAt: null, status: 'pending',
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    ...overrides,
  };
}

async function seedEnvelope(value: ReachEnvelope) {
  await client.query(`INSERT INTO auth.reach_envelopes (reach_id,principal_did,envelope)
    VALUES ($1,$2,$3::jsonb)`, [value.reachId, value.principalDid, JSON.stringify(value)]);
}

async function seedKnock(value: KnockRecord) {
  await client.query(`INSERT INTO auth.agent_knocks
    (id,agent_did,declared_target,self_description,requested_capabilities,external_did,status,expires_at,created_at)
    VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)`, [
    value.knockId, value.agentDid, value.declaredTarget, value.selfDescription,
    JSON.stringify(value.requestedCapabilities), value.externalDid, value.status, value.expiresAt, value.createdAt,
  ]);
}

async function seedCard(fields: ReturnType<typeof knockCardFields> | ReturnType<typeof reachCardFields>, overrides = {}) {
  await drizzle(client).insert(operatorApprovals).values({
    ...fields, operatorDid: principalDid, contentHash: computeApprovalContentHash(fields),
    status: 'pending', ...overrides,
  });
}

async function cards() {
  return (await client.query<Record<string, unknown>>('SELECT * FROM operator.approvals ORDER BY proposal_id')).rows;
}

async function recover() {
  queries.length = 0;
  await backfillReachApprovals(principalDid);
  return [...queries];
}

beforeAll(async () => {
  client = new PGlite();
  await client.waitReady;
  await client.exec(`
    CREATE SCHEMA auth; CREATE SCHEMA operator;
    ${OPERATOR_APPROVALS_TABLE_SQL}
    CREATE TABLE auth.reach_envelopes (reach_id text PRIMARY KEY, principal_did text NOT NULL,
      envelope jsonb NOT NULL, created_at timestamptz DEFAULT now());
    CREATE TABLE auth.agent_knocks (
      id text PRIMARY KEY, public_key text, agent_did text, declared_target text,
      self_description text, requested_capabilities jsonb, external_did text,
      external_did_verification text, external_did_verified_at timestamptz, status text,
      expires_at timestamptz, created_at timestamptz DEFAULT now(), responded_at timestamptz);
    CREATE TABLE auth.reach_sender_blocks (principal_did text, requester_did text);
  `);
  queries = [];
  // Observe the engine boundary, not just getClient().unsafe: the real
  // listPendingKnocksForTarget Drizzle SELECT must count toward the bound.
  const query = client.query.bind(client);
  vi.spyOn(client, 'query').mockImplementation((...args: Parameters<typeof client.query>) => {
    queries.push(args[0]);
    return query(...args);
  });
  state.db = drizzle(client);
  state.sql = { unsafe: async (sql: string, params: unknown[]) => (await client.query(sql, params)).rows };
});

beforeEach(async () => {
  vi.mocked(pushWebNotificationToOperator).mockReset().mockResolvedValue(undefined);
  await client.exec('TRUNCATE auth.reach_envelopes, auth.agent_knocks, operator.approvals, auth.reach_sender_blocks');
});
afterAll(async () => client.close());

describe('batched Reach recovery', () => {
  it('recovers 100 Reach + 20 knocks in four statements including Drizzle; retries preserve rows and do not push', async () => {
    for (let index = 0; index < 100; index++) await seedEnvelope(envelope(index));
    for (let index = 0; index < 20; index++) await seedKnock(knock(index));
    const statements = await recover();
    expect(statements).toHaveLength(4);
    expect(statements[1]).toContain('"auth"."agent_knocks"');
    expect(statements.filter((sql) => /INSERT INTO operator.approvals/.test(sql))).toHaveLength(1);
    expect(statements.filter((sql) => /UPDATE operator.approvals/.test(sql))).toHaveLength(1);
    const first = await cards();
    expect(first).toHaveLength(120);
    expect(first.every((row) => row.status === 'pending' && row.operator_did === principalDid)).toBe(true);
    expect(first.find((row) => row.proposal_id === 'reach:r-0')).toMatchObject({
      content_hash: computeApprovalContentHash(reachCardFields(envelope(0))),
      notification_id: null, signer_did: 'did:imajin:sender-0',
    });
    expect(JSON.stringify(first)).not.toContain('private-reply-handle');
    expect(pushWebNotificationToOperator).toHaveBeenCalledTimes(1);
    expect(pushWebNotificationToOperator).toHaveBeenCalledWith(principalDid,
      expect.objectContaining({ body: '120 incoming Reach or knock requests', url: '/jin' }));
    expect(await recover()).toHaveLength(4);
    expect(await cards()).toEqual(first);
    expect(pushWebNotificationToOperator).toHaveBeenCalledTimes(1);
  });

  it('skips legacy replies/decisions, expired/nonpending knocks and other principals without changing blocks', async () => {
    await seedEnvelope({ ...envelope(0), reply: {} as ReachEnvelope['reply'] });
    await seedEnvelope({ ...envelope(1), approvalDecision: {} as ReachEnvelope['approvalDecision'] });
    await seedEnvelope(envelope(2, otherDid));
    await seedKnock(knock(0, { status: 'accepted' }));
    await seedKnock(knock(1, { status: 'declined' }));
    await seedKnock(knock(2, { expiresAt: new Date(Date.now() - 1000).toISOString() }));
    await seedKnock(knock(3, { declaredTarget: otherDid }));
    await client.query('INSERT INTO auth.reach_sender_blocks VALUES ($1,$2)', [principalDid, 'blocked-sender']);
    const statements = await recover();
    expect(statements).toHaveLength(2);
    expect(await cards()).toEqual([]);
    expect((await client.query('SELECT * FROM auth.reach_sender_blocks')).rows)
      .toEqual([{ principal_did: principalDid, requester_did: 'blocked-sender' }]);
    expect(pushWebNotificationToOperator).not.toHaveBeenCalled();
  });

  it('expires superseded pending knock cards without changing evidence, decisions, other owners or kinds', async () => {
    const old = knock(0);
    const oldFields = knockCardFields(old);
    await seedCard(oldFields);
    const priorDecision = { payload: { mode: 'reply' }, signature: 'operator-signed' };
    await seedCard({ ...oldFields, proposalId: 'old-decided' }, { status: 'applied', decision: priorDecision });
    await seedCard({ ...oldFields, proposalId: 'other-owner' }, { operatorDid: otherDid });
    await seedCard({ ...oldFields, proposalId: 'other-kind', kind: 'knock:other' });
    const before = await cards();
    const refreshed = { ...old, selfDescription: 'Refreshed', expiresAt: new Date(Date.now() + 7200_000).toISOString() };
    await seedKnock(refreshed);
    expect(await recover()).toHaveLength(4);
    const after = await cards();
    const oldBefore = before.find((row) => row.proposal_id === oldFields.proposalId)!;
    expect(after.find((row) => row.proposal_id === oldFields.proposalId)).toEqual({
      ...oldBefore, status: 'expired', updated_at: expect.any(Date),
    });
    for (const id of ['old-decided', 'other-owner', 'other-kind']) {
      expect(after.find((row) => row.proposal_id === id)).toEqual(before.find((row) => row.proposal_id === id));
    }
    const refreshedFields = knockCardFields(refreshed);
    expect(after.find((row) => row.proposal_id === refreshedFields.proposalId)).toMatchObject({
      content_hash: computeApprovalContentHash(refreshedFields), detail: refreshedFields.detail, status: 'pending',
    });
    expect(await recover()).toHaveLength(4);
    expect(await cards()).toEqual(after);
    expect(pushWebNotificationToOperator).toHaveBeenCalledTimes(1);
  });

  it('keeps existing Reach evidence and prior decisions immutable and never republishes them', async () => {
    const original = envelope(0);
    const fields = reachCardFields(original);
    await seedCard(fields, { status: 'applied', decision: { signature: 'signed-decision' } });
    const before = await cards();
    await seedEnvelope({ ...original, message: 'Different recovery input' });
    expect(await recover()).toHaveLength(3);
    expect(await cards()).toEqual(before);
    expect(pushWebNotificationToOperator).not.toHaveBeenCalled();
  });

  it('recovers missing cards on concurrent retries without duplicate-key failures or duplicate pushes', async () => {
    await seedEnvelope(envelope(0));
    await Promise.all([backfillReachApprovals(principalDid), backfillReachApprovals(principalDid)]);
    expect(await cards()).toHaveLength(1);
    expect(pushWebNotificationToOperator).toHaveBeenCalledTimes(1);
  });

  it('does not roll back new approvals when aggregate webpush rejects', async () => {
    vi.mocked(pushWebNotificationToOperator).mockRejectedValueOnce(new Error('push unavailable'));
    await seedEnvelope(envelope(0));
    await expect(recover()).resolves.toHaveLength(3);
    expect(await cards()).toHaveLength(1);
    expect(await recover()).toHaveLength(3);
    expect(pushWebNotificationToOperator).toHaveBeenCalledTimes(1);
  });
});
