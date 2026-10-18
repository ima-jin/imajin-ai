import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { canonicalize, crypto as authCrypto, type Identity } from '@imajin/auth';
import { operatorApprovals } from '@/src/db/schemas/operator-approvals';
import type { ReachEnvelope } from '@/src/db/schemas/reach';
import { didFromPublicKey } from '../../auth/crypto';
import { computeApprovalContentHash, type OperatorCountersignFields } from '../operator-approvals';
import { countersignedMessage } from '../operator-countersign-fields';
import { reachCardFields, knockCardFields, publishReachApproval, publishKnockApproval } from '../reach-approvals';
import { decideOperatorApproval } from '../operator-approvals-service';
import { isReachSenderBlocked } from '../../auth/reach-block';
import { reachStatus } from '../../auth/reach-status';

const state = vi.hoisted(() => ({ database: null as unknown, sql: null as unknown, failChat: false }));
vi.mock('@imajin/db', () => ({ getClient: () => state.sql }));
vi.mock('@/src/db', async () => {
  const approvals = await import('@/src/db/schemas/operator-approvals');
  const auth = await import('@/src/db/schemas/auth');
  return {
    operatorApprovals: approvals.operatorApprovals, identities: auth.identities,
    get db() { return state.database; },
  };
});
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeSelfInfo: vi.fn() }));
vi.mock('@/src/lib/vault/sealing', () => ({
  getNodeSigningIdentity: () => ({ privateKeyHex: '11'.repeat(32), senderPubkey: authCrypto.getPublicKey('11'.repeat(32)) }),
}));
vi.mock('@imajin/bus', () => ({ publish: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../web-push', () => ({ pushWebNotificationToOperator: vi.fn().mockResolvedValue(undefined) }));
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let database: PGlite;
const principalDid = 'did:imajin:principal';
const actorDid = 'did:imajin:admin';
const actorKey = '22'.repeat(32);
const principalKey = '33'.repeat(32);
const senderKey = '44'.repeat(32);
const senderDid = didFromPublicKey(authCrypto.getPublicKey(senderKey));
const principal: Identity = { id: principalDid, scope: 'actor', subtype: 'human' };
const admin: Identity = { id: actorDid, scope: 'actor', subtype: 'human', actingAs: principalDid, actingAsRole: 'admin' };
let envelope: ReachEnvelope;

function adapter(client: Pick<PGlite, 'query'>) {
  return {
    unsafe: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('pg_advisory_xact_lock')) return [];
      if (state.failChat && sql.includes('INSERT INTO chat.conversation_members')) throw new Error('injected chat failure');
      return (await client.query(sql, params)).rows;
    },
  };
}

beforeAll(async () => {
  database = new PGlite();
  await database.waitReady;
  await database.exec(`
    CREATE SCHEMA auth; CREATE SCHEMA operator; CREATE SCHEMA connections; CREATE SCHEMA chat;
    CREATE TABLE auth.identities (id text PRIMARY KEY, scope text, subtype text, public_key text, tier text, metadata jsonb);
    CREATE TABLE auth.identity_members (identity_did text, member_did text, role text, removed_at timestamptz);
    CREATE TABLE auth.reach_envelopes (reach_id text PRIMARY KEY, principal_did text, requester_did text, envelope jsonb);
    CREATE TABLE auth.reach_sender_blocks (principal_did text, requester_did text, created_at timestamptz DEFAULT now(), PRIMARY KEY (principal_did, requester_did));
    CREATE TABLE auth.foreign_agent_stubs (stub_did text, principal_did text, requester_did text, signer_key text,
      requester_aliases jsonb DEFAULT '[]', signer_aliases jsonb DEFAULT '[]', promoted_to text, revoked_at timestamptz);
    CREATE TABLE auth.agent_knocks (id text PRIMARY KEY, declared_target text, agent_did text, public_key text,
      self_description text, requested_capabilities jsonb, external_did text, status text, expires_at timestamptz,
      created_at timestamptz DEFAULT now(), responded_at timestamptz);
    CREATE TABLE operator.approvals (proposal_id text PRIMARY KEY, operator_did text, source text, kind text, summary text,
      keys_touched jsonb, detail jsonb, content_hash text, notification_id text, signer_did text, status text,
      decision jsonb, outcome jsonb, applied_at timestamptz, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
    CREATE TABLE connections.connections (did_a text, did_b text, disconnected_at timestamptz, connected_at timestamptz DEFAULT now(), PRIMARY KEY(did_a,did_b));
    CREATE TABLE chat.conversations_v2 (did text PRIMARY KEY, type text, created_by text);
    CREATE TABLE chat.conversation_members (conversation_did text, member_did text, role text, left_at timestamptz, UNIQUE(conversation_did,member_did));
  `);
  state.database = drizzle(database);
  state.sql = {
    ...adapter(database),
    begin: async (_isolation: string, fn: (tx: ReturnType<typeof adapter>) => Promise<unknown>) => database.transaction((tx) => fn(adapter(tx))),
  };
});

beforeEach(async () => {
  state.failChat = false;
  await database.exec(`TRUNCATE auth.identities, auth.identity_members, auth.reach_envelopes, auth.reach_sender_blocks,
    auth.foreign_agent_stubs, auth.agent_knocks, operator.approvals, connections.connections, chat.conversations_v2, chat.conversation_members`);
  for (const [id, key] of [[principalDid, principalKey], [actorDid, actorKey]]) {
    await database.query("INSERT INTO auth.identities (id,scope,subtype,public_key,tier) VALUES ($1,'actor','human',$2,'established')",
      [id, authCrypto.getPublicKey(key)]);
  }
  await database.query("INSERT INTO auth.identity_members VALUES ($1,$2,'admin',null)", [principalDid, actorDid]);
  envelope = {
    reachId: 'reach-test', principalDid, requesterDid: senderDid, requesterTier: 'reach-only',
    onBehalfOfStubDid: 'claimed-person', onBehalfOf: { platform: 'test', externalRef: 'unverified', selfDescription: 'My claim' },
    claimVerified: false, topic: 'public-topic', message: 'Hello', transcriptHash: 'transcript',
    replyHandle: 'private-handle', requesterSignature: 'requester-signature', grantId: null,
    issuedAt: new Date().toISOString(), requestIssuedAt: new Date().toISOString(), signedEvent: {},
  };
  await database.query('INSERT INTO auth.reach_envelopes VALUES ($1,$2,$3,$4::jsonb)',
    [envelope.reachId, principalDid, senderDid, JSON.stringify(envelope)]);
  await database.query(`INSERT INTO auth.foreign_agent_stubs (stub_did,principal_did,requester_did,signer_key)
    VALUES ('foreign-stub',$1,$2,$3)`, [principalDid, senderDid, authCrypto.getPublicKey(senderKey)]);
  const fields = reachCardFields(envelope);
  await drizzle(database).insert(operatorApprovals).values({
    ...fields, operatorDid: principalDid, signerDid: senderDid, contentHash: computeApprovalContentHash(fields), status: 'pending',
  });
});

afterAll(async () => database.close());

function command(mode: string, identity = principal, replyMessage?: string) {
  const fields: OperatorCountersignFields = {
    contentHash: computeApprovalContentHash(reachCardFields(envelope)), decision: 'approve',
    decidedAt: new Date().toISOString(), mode, ...(replyMessage === undefined ? {} : { replyMessage }),
  };
  const key = identity.id === actorDid ? actorKey : principalKey;
  return {
    proposalId: `reach:${envelope.reachId}`, identity, operatorDid: identity.id, ...fields,
    operatorSignature: { keyId: authCrypto.getPublicKey(key), alg: 'ed25519' as const, sig: authCrypto.signSync(countersignedMessage(fields), key) },
  };
}

describe('shared Reach decision path', () => {
  it.each(['reply', 'accept', 'decline', 'block'])('handles knock %s with the same signed path', async (mode) => {
    const knock = {
      knockId: 'knock-test', agentDid: senderDid, declaredTarget: principalDid, selfDescription: 'Knock message',
      requestedCapabilities: [], externalDid: null, externalDidVerification: null, externalDidVerifiedAt: null,
      status: 'pending' as const, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    await database.query(`INSERT INTO auth.agent_knocks
      (id,declared_target,agent_did,public_key,self_description,requested_capabilities,status,expires_at)
      VALUES ($1,$2,$3,$4,$5,'[]','pending',$6)`,
    [knock.knockId, principalDid, senderDid, authCrypto.getPublicKey(senderKey), knock.selfDescription, knock.expiresAt]);
    await publishKnockApproval(knock);
    await publishKnockApproval(knock);
    const fields = knockCardFields(knock);
    const signedFields = {
      contentHash: computeApprovalContentHash(fields), decision: 'approve' as const, mode,
      decidedAt: new Date().toISOString(), ...(mode === 'reply' ? { replyMessage: 'Knock reply' } : {}),
    };
    const params = {
      ...signedFields, proposalId: fields.proposalId, operatorDid: principalDid, identity: principal,
      operatorSignature: { keyId: authCrypto.getPublicKey(principalKey), alg: 'ed25519' as const,
        sig: authCrypto.signSync(countersignedMessage(signedFields), principalKey) },
    };
    expect((await decideOperatorApproval(params)).ok).toBe(true);
    expect((await decideOperatorApproval(params)).ok).toBe(true);
    const [stored] = (await database.query<{ status: string }>('SELECT status FROM auth.agent_knocks')).rows;
    expect(stored.status).toBe(mode === 'reply' ? 'pending' : mode === 'accept' ? 'accepted' : 'declined');
    expect((await database.query('SELECT * FROM chat.conversations_v2')).rows).toHaveLength(mode === 'accept' ? 1 : 0);
  });

  it('recovers publication and expires old knock cards after refresh without changing signed content', async () => {
    await database.exec('TRUNCATE operator.approvals');
    await publishReachApproval(envelope);
    await publishReachApproval(envelope);
    expect((await database.query('SELECT * FROM operator.approvals')).rows).toHaveLength(1);
    const knock = {
      knockId: 'knock-test', agentDid: senderDid, declaredTarget: principalDid, selfDescription: 'Original',
      requestedCapabilities: [], externalDid: null, externalDidVerification: null, externalDidVerifiedAt: null,
      status: 'pending' as const, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    await publishKnockApproval(knock);
    await publishKnockApproval({ ...knock, selfDescription: 'Refresh' });
    const rows = (await database.query<{ status: string; detail: { message: string } }>("SELECT status, detail FROM operator.approvals WHERE source = 'knock'")).rows;
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'expired', detail: expect.objectContaining({ message: 'Original' }) }),
      expect.objectContaining({ status: 'pending', detail: expect.objectContaining({ message: 'Refresh' }) }),
    ]));
  });

  it('keeps other approval kinds self-only even for a verified act-as admin', async () => {
    await database.exec("UPDATE operator.approvals SET source = 'system-agent', kind = 'system-agent:restart'");
    expect(await decideOperatorApproval({ ...command('decline', admin), mode: undefined })).toMatchObject({ ok: false, status: 403 });
  });
  it.each(['reply', 'accept', 'decline', 'block'])('commits signed %s once; only Accept creates a chat and full identity', async (mode) => {
    const params = command(mode, principal, mode === 'reply' ? 'Signed reply' : undefined);
    const result = await decideOperatorApproval(params);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.card.status).toBe('applied');
      expect(result.card.decision?.mode).toBe(mode);
      expect(result.card.decision?.decidedBy).toBe(principalDid);
    }
    expect((await database.query('SELECT * FROM chat.conversations_v2')).rows).toHaveLength(mode === 'accept' ? 1 : 0);
    expect((await database.query('SELECT * FROM auth.identities WHERE id = $1', [senderDid])).rows).toHaveLength(mode === 'accept' ? 1 : 0);
    expect((await decideOperatorApproval(params)).ok).toBe(true);
    expect(await isReachSenderBlocked({ principalDid, requesterDid: senderDid })).toBe(mode === 'block');
    const status = await reachStatus({ principalDid, requesterDid: senderDid, reachId: envelope.reachId });
    if (mode === 'reply') expect(status).toMatchObject({ state: 'replied', approvalDecision: { payload: { replyMessage: 'Signed reply' } } });
    if (mode === 'block') expect(status).toEqual({ reachId: envelope.reachId, state: 'blocked', reply: null });
  });

  it('allows a live act-as admin and attributes the real actor/key, never the borrowed identity', async () => {
    const result = await decideOperatorApproval(command('reply', admin, 'Admin reply'));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.card.decision).toMatchObject({ decidedBy: actorDid, operatorSignature: { keyId: authCrypto.getPublicKey(actorKey) } });
  });

  it.each(['maintainer', 'member', 'agent'])('denies act-as role %s despite forged admin hint', async (role) => {
    await database.query('UPDATE auth.identity_members SET role = $1', [role]);
    expect(await decideOperatorApproval(command('decline', admin))).toMatchObject({ ok: false, status: 403 });
  });

  it('denies removed admins, delegates, non-owners and non-human principals', async () => {
    await database.exec('UPDATE auth.identity_members SET removed_at = now()');
    for (const identity of [admin, { ...admin, actingAs: undefined }, { ...principal, actingFor: principalDid },
      { ...principal, subtype: 'agent' }]) {
      expect(await decideOperatorApproval(command('decline', identity))).toMatchObject({ ok: false, status: 403 });
    }
  });

  it('requires signatures regardless node flag and detects tampered reply/mode/key', async () => {
    vi.stubEnv('OPERATOR_COUNTERSIGN_REQUIRED', 'false');
    const params = command('reply', principal, 'Original');
    expect(await decideOperatorApproval({ ...params, operatorSignature: undefined })).toMatchObject({ ok: false, status: 400 });
    expect(await decideOperatorApproval({ ...params, replyMessage: 'Tampered' })).toMatchObject({ ok: false, status: 400 });
    expect(await decideOperatorApproval({ ...command('decline'), mode: 'block' })).toMatchObject({ ok: false, status: 400 });
    expect(await decideOperatorApproval({ ...params, operatorSignature: command('reply', admin, 'Original').operatorSignature })).toMatchObject({ ok: false, status: 400 });
    vi.unstubAllEnvs();
  });

  it('validates mode/reply bounds before mutation', async () => {
    for (const params of [command('reply'), command('reply', principal, ' '), command('reply', principal, 'x'.repeat(16001)),
      command('decline', principal, 'unexpected'), command('invalid'), { ...command('block'), decision: 'reject' as const }]) {
      expect(await decideOperatorApproval(params)).toMatchObject({ ok: false, status: 400 });
    }
  });

  it('rolls back identity, connection, conversation and decision on failure, then permits retry', async () => {
    const params = command('accept');
    state.failChat = true;
    await expect(decideOperatorApproval(params)).rejects.toThrow('injected chat failure');
    expect((await database.query('SELECT * FROM auth.identities WHERE id = $1', [senderDid])).rows).toHaveLength(0);
    expect((await database.query('SELECT * FROM connections.connections')).rows).toHaveLength(0);
    expect((await database.query('SELECT status FROM operator.approvals')).rows[0]).toEqual({ status: 'pending' });
    state.failChat = false;
    expect((await decideOperatorApproval(params)).ok).toBe(true);
  });

  it('does not decide a refreshed knock or a legacy-replied Reach, and never leaks internal fields', async () => {
    await database.query("UPDATE auth.reach_envelopes SET envelope = envelope || '{\"reply\":{}}'::jsonb");
    expect(await decideOperatorApproval(command('decline'))).toMatchObject({ ok: false, status: 409 });
    const fields = reachCardFields({ ...envelope, ...{ gateRules: 'secret', unpublishedTopics: ['private'] } });
    expect(JSON.stringify(fields)).not.toContain('secret');
    expect(JSON.stringify(fields)).not.toContain('private-handle');
    const knock = knockCardFields({
      knockId: 'k', agentDid: senderDid, declaredTarget: principalDid, selfDescription: 'Hello',
      requestedCapabilities: [], externalDid: null, externalDidVerification: 'verified', externalDidVerifiedAt: null,
      status: 'pending', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 10000).toISOString(),
    });
    expect(knock.detail).toMatchObject({ message: 'Hello', claimVerified: false, requesterTier: 'unknown', onBehalfOf: { platform: 'unspecified' } });
    expect(canonicalize(knock)).not.toContain('verifiedAt');
  });
});
