import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { canonicalize, crypto as authCrypto, SIGNED_MESSAGE_MAX_AGE, FUTURE_TOLERANCE, type Identity } from '@imajin/auth';
import { NextRequest } from 'next/server';
import type { ReachEnvelope } from '@/src/db/schemas/reach';
import { GET } from '@/app/jin/api/reach/route';
import { POST } from '@/app/jin/api/reach/[reachId]/reply/route';
import { POST as BLOCK } from '@/app/jin/api/reach/[reachId]/block/route';
import { blockReachSender, getReachEnvelope } from '../reach-envelope-store';
import { listReachInbox, markReachReplyPublished, persistReachReply } from '../reach-reply-store';
import { isReachPrincipal, parseReachReplyInput, replyToReach, type ReachReplyInput } from '../reach-reply-service';
import { canonicalReachReply, reachReplyEvent, type SignedReachReplyEvent } from '../reach-reply-wire';

const mocked = vi.hoisted(() => ({
  getClient: vi.fn(), rows: vi.fn(), publish: vi.fn(), requireAuth: vi.fn(),
}));
vi.mock('@imajin/db', () => ({ getClient: mocked.getClient }));
vi.mock('@imajin/bus', () => ({ publish: mocked.publish }));
vi.mock('../foreign-agent-stub', () => ({ blockForeignAgentStub: vi.fn().mockResolvedValue(true) }));
vi.mock('@/src/lib/access/reach-bearer', () => ({ listReachBearerKnocks: async () => [] }));
vi.mock('@/src/db', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: mocked.rows }) }) }) },
  identities: {},
}));
vi.mock('@imajin/auth', async (original) => ({
  ...await original<typeof import('@imajin/auth')>(), requireAuth: mocked.requireAuth,
}));
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const keys = authCrypto.generateKeypair();
const identity: Identity = { id: 'did:imajin:owner', scope: 'actor', subtype: 'human' };
const envelope: ReachEnvelope = {
  reachId: 'reach_1', principalDid: identity.id, requesterDid: 'did:imajin:sender',
  onBehalfOfStubDid: 'did:imajin:stub', onBehalfOf: { platform: 'foreign', externalRef: 'opaque' },
  claimVerified: false, topic: 'collaboration', message: 'Private ask', replyHandle: 'opaque:reply',
  transcriptHash: 'hash-1', requesterSignature: 'sender-signature', requesterTier: 'established',
  grantId: 'grant-1', issuedAt: new Date().toISOString(), requestIssuedAt: new Date().toISOString(),
  signedEvent: { type: 'agent.reach.delivered' },
};
let database: PGlite;
let failUpdate = false;
let calls: Array<{ sql: string; values: unknown[]; transaction: boolean }>;

function signedInput(message = 'Yes, let us talk', issuedAt = new Date().toISOString()): ReachReplyInput {
  const event = reachReplyEvent(envelope, message, issuedAt);
  return {
    message, issuedAt,
    signature: { keyId: keys.publicKey, alg: 'ed25519', sig: authCrypto.signSync(canonicalReachReply(event), keys.privateKey) },
  };
}

function signedEvent(input = signedInput()): SignedReachReplyEvent {
  const event = reachReplyEvent(envelope, input.message, input.issuedAt);
  return { ...event, payload: { ...event.payload, signature: input.signature } };
}

function request(body: unknown): NextRequest {
  return new NextRequest('https://example.test/jin/api/reach/reach_1/reply', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

function executor(target: Pick<PGlite, 'query'>, transaction: boolean) {
  return {
    async unsafe(sql: string, values: unknown[] = []) {
      calls.push({ sql, values, transaction });
      // PGlite is single connection; record the actual advisory lock boundary,
      // but do not claim this proves multi-connection PostgreSQL contention.
      if (sql.includes('pg_advisory_xact_lock')) return [];
      if (failUpdate && sql.includes('UPDATE auth.reach_envelopes')) throw new Error('update failed');
      return (await target.query(sql, values)).rows;
    },
  };
}

beforeAll(async () => {
  database = new PGlite();
  await database.waitReady;
  const migration = readFileSync(fileURLToPath(new URL(
    '../../../../../../migrations/archive/pre-kernel-baseline/0195_reach_envelopes.sql', import.meta.url,
  )), 'utf8');
  await database.exec(migration);
  await database.exec('CREATE TABLE auth.identities (registered_by_app_did text,id text PRIMARY KEY)');
  await database.exec(readFileSync(new URL(
    '../../../../../../migrations/0198_foreign_agent_stubs.sql', import.meta.url,
  ), 'utf8'));
});
afterAll(async () => { await database?.close(); });
beforeEach(async () => {
  await database.exec('TRUNCATE auth.reach_envelopes, auth.reach_sender_blocks, auth.foreign_agent_stubs, auth.identities');
  await database.query(`INSERT INTO auth.reach_envelopes
    (reach_id, principal_did, requester_did, transcript_hash, envelope)
    VALUES ($1, $2, $3, $4, $5::jsonb)`,
  [envelope.reachId, envelope.principalDid, envelope.requesterDid, envelope.transcriptHash, JSON.stringify(envelope)]);
  calls = [];
  failUpdate = false;
  vi.clearAllMocks();
  mocked.rows.mockResolvedValue([{ id: identity.id, publicKey: keys.publicKey, type: 'actor', tier: 'established' }]);
  mocked.requireAuth.mockResolvedValue({ identity });
  mocked.publish.mockResolvedValue(undefined);
  mocked.getClient.mockReturnValue({
    ...executor(database, false),
    begin: (isolation: string, fn: (tx: ReturnType<typeof executor>) => Promise<unknown>) => {
      expect(isolation).toBe('isolation level read committed');
      return database.transaction((tx) => fn(executor(tx, true)));
    },
  });
});

describe('reach reply principal signatures and persistence', () => {
  it('matches auth canonicalization and verifies the exact unsigned wire event', () => {
    const input = signedInput('Unicode ♥ "quotes"');
    const event = reachReplyEvent(envelope, input.message, input.issuedAt);
    expect(canonicalReachReply(event)).toBe(canonicalize(event));
    expect(event).toMatchObject({
      type: 'agent.reach.replied', issuer: identity.id, subject: identity.id, scope: 'agent',
      payload: { state: 'replied', context_id: envelope.reachId, context_type: 'agent.reach' },
    });
    expect(authCrypto.verifySync(input.signature.sig, canonicalReachReply(event), keys.publicKey)).toBe(true);
  });

  it('commits the full human-signed event and acknowledges after publish without changing delivery', async () => {
    const input = signedInput();
    const result = await replyToReach({ identity, reachId: envelope.reachId, input });
    expect(result).toEqual({ ok: true, reply: signedEvent(input) });
    expect(mocked.publish).toHaveBeenCalledWith('agent.reach.replied', signedEvent(input));
    const stored = await getReachEnvelope(envelope);
    expect(stored).toMatchObject({ ...envelope, reply: signedEvent(input), replyPublishedAt: expect.any(String) });
    const writes = calls.filter((call) => call.sql.includes('UPDATE auth.reach_envelopes'));
    expect(writes.every((call) => call.transaction)).toBe(true);
    for (const write of writes) {
      const index = calls.indexOf(write);
      expect(calls.slice(0, index).some((call) => call.sql.includes('pg_advisory_xact_lock')
        && call.values[0] === `reach:${identity.id}` && call.transaction)).toBe(true);
    }
  });

  it('retains a pending event on publish failure and replays the same signed bytes once acknowledged', async () => {
    const input = signedInput();
    mocked.publish.mockRejectedValueOnce(new Error('bus down'));
    await expect(replyToReach({ identity, reachId: envelope.reachId, input })).rejects.toThrow('bus down');
    expect(await getReachEnvelope(envelope)).toMatchObject({ reply: signedEvent(input) });
    expect((await getReachEnvelope(envelope))?.replyPublishedAt).toBeUndefined();
    expect(await replyToReach({ identity, reachId: envelope.reachId, input })).toEqual({ ok: true, reply: signedEvent(input) });
    await replyToReach({ identity, reachId: envelope.reachId, input });
    expect(mocked.publish).toHaveBeenCalledTimes(2);
    expect(mocked.publish.mock.calls[0]).toEqual(mocked.publish.mock.calls[1]);
  });

  it('does not let bus reactor annotations mutate the signed response or persisted reply', async () => {
    const input = signedInput();
    mocked.publish.mockImplementationOnce((_type: string, event: SignedReachReplyEvent) => {
      Object.assign(event.payload, { attestationId: 'reactor-added' });
      return Promise.resolve();
    });
    expect(await replyToReach({ identity, reachId: envelope.reachId, input }))
      .toEqual({ ok: true, reply: signedEvent(input) });
    expect((await getReachEnvelope(envelope))?.reply).toEqual(signedEvent(input));
  });

  it('keeps a committed event pending if the publication acknowledgement fails', async () => {
    const input = signedInput();
    mocked.publish.mockImplementationOnce(() => { failUpdate = true; return Promise.resolve(); });
    await expect(replyToReach({ identity, reachId: envelope.reachId, input })).rejects.toThrow('update failed');
    failUpdate = false;
    expect((await getReachEnvelope(envelope))?.replyPublishedAt).toBeUndefined();
    expect(await replyToReach({ identity, reachId: envelope.reachId, input })).toMatchObject({ ok: true });
    expect(mocked.publish).toHaveBeenCalledTimes(2);
  });

  it('recovers an exact pending event even after the freshness window', async () => {
    const input = signedInput('Original', new Date(Date.now() - SIGNED_MESSAGE_MAX_AGE - 1000).toISOString());
    await persistReachReply({ ...envelope, reply: signedEvent(input) });
    expect(await replyToReach({ identity, reachId: envelope.reachId, input })).toEqual({ ok: true, reply: signedEvent(input) });
  });

  it('refuses replacement replies without overwriting original bytes', async () => {
    const input = signedInput();
    await replyToReach({ identity, reachId: envelope.reachId, input });
    expect(await replyToReach({ identity, reachId: envelope.reachId, input: signedInput('Different') }))
      .toMatchObject({ ok: false, status: 409 });
    expect((await getReachEnvelope(envelope))?.reply).toEqual(signedEvent(input));
    expect(mocked.publish).toHaveBeenCalledTimes(1);
  });

  it.each(['missing', 'nonowner'])('refuses %s envelope access without publishing', async (kind) => {
    const params = { identity, reachId: 'unknown', input: signedInput() };
    if (kind === 'nonowner') {
      params.reachId = envelope.reachId;
      params.identity = { ...identity, id: 'did:imajin:other' };
    }
    expect(await replyToReach(params)).toMatchObject({ ok: false, status: 404 });
    expect(mocked.publish).not.toHaveBeenCalled();
  });

  it('serializes a committed block before refusing a reply, including pending retries', async () => {
    const input = signedInput();
    await persistReachReply({ ...envelope, reply: signedEvent(input) });
    await blockReachSender(envelope);
    expect(await replyToReach({ identity, reachId: envelope.reachId, input })).toMatchObject({ ok: false, status: 403 });
    expect(mocked.publish).not.toHaveBeenCalled();
    expect(calls.filter((call) => call.sql.includes('pg_advisory_xact_lock'))
      .every((call) => call.transaction && call.values[0] === `reach:${identity.id}`)).toBe(true);
  });

  it('does not store a first reply after blocking', async () => {
    await blockReachSender(envelope);
    expect(await replyToReach({ identity, reachId: envelope.reachId, input: signedInput() }))
      .toMatchObject({ ok: false, status: 403 });
    expect((await getReachEnvelope(envelope))?.reply).toBeUndefined();
  });

  it('rolls back failed reply writes', async () => {
    failUpdate = true;
    await expect(replyToReach({ identity, reachId: envelope.reachId, input: signedInput() })).rejects.toThrow('update failed');
    expect((await getReachEnvelope(envelope))?.reply).toBeUndefined();
    expect(mocked.publish).not.toHaveBeenCalled();
  });

  it('scopes publication acknowledgement to the owner and makes it idempotent', async () => {
    await persistReachReply({ ...envelope, reply: signedEvent() });
    await markReachReplyPublished({ ...envelope, principalDid: 'wrong' });
    expect((await getReachEnvelope(envelope))?.replyPublishedAt).toBeUndefined();
    await markReachReplyPublished(envelope);
    const original = await getReachEnvelope(envelope);
    await markReachReplyPublished(envelope);
    expect(await getReachEnvelope(envelope)).toEqual(original);
  });

  it.each(['issuer', 'subject', 'type', 'scope', 'reachId', 'principalDid', 'requesterDid', 'transcriptHash', 'context_id', 'context_type', 'state'])(
    'rejects a stored event with a mismatched %s binding', async (field) => {
      const reply = signedEvent();
      if (['issuer', 'subject', 'type', 'scope'].includes(field)) Object.assign(reply, { [field]: 'other' });
      else Object.assign(reply.payload, { [field]: 'other' });
      expect(await persistReachReply({ ...envelope, reply })).toMatchObject({ ok: false, status: 403 });
    },
  );

  it.each(['message', 'issuedAt', 'keyId', 'sig'])('rejects tampered %s with real Ed25519 verification', async (field) => {
    const input = signedInput();
    if (field === 'message') input.message = 'Forged';
    if (field === 'issuedAt') input.issuedAt = new Date(Date.now() + 1000).toISOString();
    if (field === 'keyId') input.signature.keyId = authCrypto.generateKeypair().publicKey;
    if (field === 'sig') input.signature.sig = '00'.repeat(64);
    expect(await replyToReach({ identity, reachId: envelope.reachId, input })).toMatchObject({ ok: false, status: 401 });
    expect(mocked.publish).not.toHaveBeenCalled();
  });

  it.each(['stale', 'future', 'malformed'])('rejects a correctly signed but invalid %s timestamp', async (kind) => {
    let issuedAt = 'not-a-date';
    if (kind === 'stale') issuedAt = new Date(Date.now() - SIGNED_MESSAGE_MAX_AGE - 10_000).toISOString();
    if (kind === 'future') issuedAt = new Date(Date.now() + FUTURE_TOLERANCE + 10_000).toISOString();
    expect(await replyToReach({ identity, reachId: envelope.reachId, input: signedInput('Reply', issuedAt) }))
      .toMatchObject({ ok: false, status: 401 });
  });

  it.each([
    { rows: [] }, { rows: [{ id: identity.id, publicKey: null }] },
    { rows: [{ id: identity.id, publicKey: authCrypto.generateKeypair().publicKey }] },
  ])(
    'rejects missing, unknown and rotated registered keys', async ({ rows }) => {
      mocked.rows.mockResolvedValue(rows);
      expect(await replyToReach({ identity, reachId: envelope.reachId, input: signedInput() }))
        .toMatchObject({ ok: false, status: 401 });
    },
  );

  it.each([null, [], {}, { message: ' ' }, { ...signedInput(), signature: undefined },
    { ...signedInput(), signature: { alg: 'rsa', keyId: keys.publicKey, sig: '00'.repeat(64) } },
    { ...signedInput(), message: 'x'.repeat(16_001) }, { ...signedInput(), issuedAt: 5 },
    { ...signedInput(), signature: { alg: 'ed25519', keyId: '', sig: '' } }])('refuses malformed input', (raw) => {
    expect(parseReachReplyInput(raw)).toBeNull();
  });

  it.each([
    { ...identity, subtype: 'agent' }, { ...identity, actingAs: 'did:group' },
    { ...identity, actingFor: identity.id }, { ...identity, scope: 'business' },
  ])('requires the direct human principal, without delegated fallbacks', async (caller) => {
    expect(isReachPrincipal(caller)).toBe(false);
    expect(await replyToReach({ identity: caller, reachId: envelope.reachId, input: signedInput() }))
      .toMatchObject({ ok: false, status: 403 });
  });
});

describe('reach inbox and reply HTTP routes', () => {
  it('lists only the authenticated human principal and requires a real session', async () => {
    const response = await GET(new NextRequest('https://example.test/jin/api/reach'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ principalDid: identity.id, envelopes: [{ ...envelope, blocked: false }], knocks: [] });
    expect(mocked.requireAuth).toHaveBeenCalledWith(expect.anything(), { sessionOnly: true });
  });

  it('POST verifies a real signature and returns the exact signed event', async () => {
    const input = signedInput();
    const response = await POST(request(input), { params: Promise.resolve({ reachId: envelope.reachId }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ reply: signedEvent(input) });
  });

  it.each(['list', 'reply'])('refuses unauthenticated %s requests', async (route) => {
    mocked.requireAuth.mockResolvedValue({ error: 'Not authenticated', status: 401 });
    const response = route === 'list'
      ? await GET(new NextRequest('https://example.test/jin/api/reach'))
      : await POST(request(signedInput()), { params: Promise.resolve({ reachId: envelope.reachId }) });
    expect(response.status).toBe(401);
  });

  it.each(['list', 'reply'])('refuses act-as on %s even for an otherwise matching human DID', async (route) => {
    mocked.requireAuth.mockResolvedValue({ identity: { ...identity, actingAs: 'did:group' } });
    const response = route === 'list'
      ? await GET(new NextRequest('https://example.test/jin/api/reach'))
      : await POST(request(signedInput()), { params: Promise.resolve({ reachId: envelope.reachId }) });
    expect(response.status).toBe(403);
  });

  it('returns 400 for unsigned input and 401 for a forged signature', async () => {
    const unsigned = await POST(request({ message: 'Unsigned' }), { params: Promise.resolve({ reachId: envelope.reachId }) });
    expect(unsigned.status).toBe(400);
    const input = signedInput();
    input.message = 'Forged';
    expect((await POST(request(input), { params: Promise.resolve({ reachId: envelope.reachId }) })).status).toBe(401);
  });

  it('rejects invalid JSON without throwing', async () => {
    const malformed = new NextRequest('https://example.test', { method: 'POST', body: '{' });
    expect((await POST(malformed, { params: Promise.resolve({ reachId: envelope.reachId }) })).status).toBe(400);
  });

  it('returns a recoverable 503 on publication failure, retaining the signed reply', async () => {
    const input = signedInput();
    mocked.publish.mockRejectedValueOnce(new Error('offline'));
    const response = await POST(request(input), { params: Promise.resolve({ reachId: envelope.reachId }) });
    expect(response.status).toBe(503);
    expect((await getReachEnvelope(envelope))?.reply).toEqual(signedEvent(input));
    expect((await POST(request(input), { params: Promise.resolve({ reachId: envelope.reachId }) })).status).toBe(200);
  });

  it('returns 500 when the inbox storage cannot be read', async () => {
    mocked.getClient.mockReturnValue({ unsafe: vi.fn().mockRejectedValue(new Error('offline')) });
    expect((await GET(new NextRequest('https://example.test/jin/api/reach'))).status).toBe(500);
  });
});

describe('owner-only reach sender block', () => {
  it('blocks the stored requester idempotently and restores authoritative state on inbox refresh', async () => {
    const props = { params: Promise.resolve({ reachId: envelope.reachId }) };
    expect(await (await BLOCK(request({ requesterDid: 'must-not-use-body' }), props)).json()).toEqual({ blocked: true });
    expect(await (await BLOCK(request({}), props)).json()).toEqual({ blocked: true });
    const refreshed = await GET(new NextRequest('https://example.test/jin/api/reach'));
    expect(await refreshed.json()).toEqual({ principalDid: identity.id, envelopes: [{ ...envelope, blocked: true }], knocks: [] });
    expect((await database.query('SELECT * FROM auth.reach_sender_blocks')).rows)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ principal_did: identity.id, requester_did: envelope.requesterDid }),
        expect.objectContaining({ principal_did: identity.id, requester_did: envelope.onBehalfOfStubDid }),
      ]));
    expect(await replyToReach({ identity, reachId: envelope.reachId, input: signedInput() }))
      .toMatchObject({ ok: false, status: 403 });
  });

  it.each(['unknown', 'nonowner'])('refuses %s reach ids without creating blocks', async (mode) => {
    const reachId = mode === 'unknown' ? 'unknown' : envelope.reachId;
    if (mode === 'nonowner') mocked.requireAuth.mockResolvedValue({ identity: { ...identity, id: 'did:imajin:other' } });
    expect((await BLOCK(request({}), { params: Promise.resolve({ reachId }) })).status).toBe(404);
    expect((await database.query('SELECT * FROM auth.reach_sender_blocks')).rows).toEqual([]);
  });

  it.each([
    { ...identity, subtype: 'agent' }, { ...identity, actingAs: 'did:group' },
    { ...identity, actingFor: identity.id },
  ])('refuses agents and every delegation shape', async (caller) => {
    mocked.requireAuth.mockResolvedValue({ identity: caller });
    expect((await BLOCK(request({}), { params: Promise.resolve({ reachId: envelope.reachId }) })).status).toBe(403);
    expect((await database.query('SELECT * FROM auth.reach_sender_blocks')).rows).toEqual([]);
  });

  it('requires a session and refuses unauthenticated callers', async () => {
    mocked.requireAuth.mockResolvedValue({ error: 'User session required', status: 401 });
    expect((await BLOCK(request({}), { params: Promise.resolve({ reachId: envelope.reachId }) })).status).toBe(401);
    expect(mocked.requireAuth).toHaveBeenCalledWith(expect.anything(), { sessionOnly: true });
  });

  it('reports a block storage failure rather than claiming success', async () => {
    mocked.getClient.mockReturnValue({
      ...executor(database, false),
      begin: vi.fn().mockRejectedValue(new Error('database unavailable')),
    });
    expect((await BLOCK(request({}), { params: Promise.resolve({ reachId: envelope.reachId }) })).status).toBe(503);
  });

  it('joins block state on both owner and requester, not untrusted envelope JSON', async () => {
    await database.query(`UPDATE auth.reach_envelopes
      SET envelope = envelope || '{"blocked":true}'::jsonb`);
    expect(await listReachInbox({ principalDid: identity.id })).toEqual([{ ...envelope, blocked: false }]);
    await blockReachSender({ principalDid: 'other-owner', requesterDid: envelope.requesterDid });
    expect(await listReachInbox({ principalDid: identity.id })).toEqual([{ ...envelope, blocked: false }]);
    expect(await listReachInbox({ principalDid: 'other-owner' })).toEqual([]);
    await blockReachSender(envelope);
    expect(await listReachInbox({ principalDid: identity.id })).toEqual([{ ...envelope, blocked: true }]);
  });
});
