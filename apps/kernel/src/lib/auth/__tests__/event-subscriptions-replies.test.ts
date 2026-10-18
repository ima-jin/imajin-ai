import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import type { BusEvent } from '@imajin/bus';

const state = vi.hoisted(() => ({ client: null as PGlite | null }));

vi.mock('@imajin/db', () => ({
  getClient: () => async (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (!state.client) throw new Error('Test database not initialized');
    const query = strings.reduce((text, part, index) => text + (index ? `$${index}` : '') + part, '');
    return (await state.client.query(query, values)).rows;
  },
}));

vi.mock('@/src/db', async () => {
  const auth = await import('../../../db/schemas/auth');
  const bus = await import('../../../db/schemas/bus');
  state.client = new PGlite();
  return { db: drizzle(state.client), ...auth, ...bus };
});

import { catchUpSubscriptionEvents } from '../event-subscriptions';
import { deliverToSubscribers } from '../../../../../../packages/bus/src/subscriptions';
import { loadReachReplyEntitlements } from '../../../../../../packages/bus/src/reach-reply-subscriptions';

const REQUESTER = 'did:imajin:requester';
const PRINCIPAL = 'did:imajin:principal';
const STRANGER = 'did:imajin:stranger';
const REPLY: BusEvent = {
  type: 'agent.reach.replied', issuer: PRINCIPAL, subject: PRINCIPAL, scope: 'agent',
  payload: {
    reachId: 'reach_1', principalDid: PRINCIPAL, requesterDid: REQUESTER,
    transcriptHash: 'transcript', message: 'PRIVATE REPLY', issuedAt: '2026-10-16T20:00:00.000Z',
    state: 'replied', context_id: 'reach_1', context_type: 'agent.reach',
    signature: { keyId: 'principal-public-key', alg: 'ed25519', sig: 'principal-signature' },
  },
};

function client(): PGlite {
  if (!state.client) throw new Error('Test database not initialized');
  return state.client;
}

async function seedEnvelope(overrides: Record<string, unknown> = {}): Promise<void> {
  const envelope = {
    reachId: 'reach_1', principalDid: PRINCIPAL, requesterDid: REQUESTER,
    transcriptHash: 'transcript', requesterTier: 'soft',
    requesterAuthTier: 'signed', requesterSignature: 'a'.repeat(128),
    grantId: 'grant_1', reply: REPLY, ...overrides,
  };
  await client().query(`
    INSERT INTO auth.reach_envelopes (reach_id, principal_did, requester_did, transcript_hash, envelope)
    VALUES ('reach_1', $1, $2, 'transcript', $3::jsonb)
  `, [PRINCIPAL, REQUESTER, JSON.stringify(envelope)]);
}

async function seedGrant(agentDid = REQUESTER, id = 'grant_1'): Promise<void> {
  await client().query(`
    INSERT INTO auth.delegation_grants (id, agent_did, delegator_did, status, expires_at, audience)
    VALUES ($1, $2, $3, 'active', now() + interval '1 hour', '{"type":"all"}')
  `, [id, agentDid, PRINCIPAL]);
  await client().query(`
    INSERT INTO auth.delegation_grant_capabilities (grant_id, capability, status)
    VALUES ($1, 'agent:reach', 'active')
  `, [id]);
}

beforeAll(async () => {
  await client().exec(`
    CREATE SCHEMA auth;
    CREATE SCHEMA kernel;
    CREATE TABLE auth.identities (
      registered_by_app_did text,id text PRIMARY KEY, tier text, suspended_at timestamptz);
    CREATE TABLE auth.delegation_grants (
      id text PRIMARY KEY, agent_did text, delegator_did text, status text,
      expires_at timestamptz, audience jsonb
    );
    CREATE TABLE auth.delegation_grant_capabilities (grant_id text, capability text, status text);
    CREATE TABLE auth.reach_envelopes (
      reach_id text PRIMARY KEY, principal_did text, requester_did text, transcript_hash text, envelope jsonb
    );
    CREATE TABLE auth.reach_sender_blocks (principal_did text, requester_did text);
    CREATE TABLE kernel.event_subscription_log (
      seq bigserial PRIMARY KEY, id text, event_type text, issuer_did text,
      subject_did text, scope text, payload jsonb, correlation_id text,
      occurred_at timestamptz, created_at timestamptz DEFAULT now()
    );
  `);
});

beforeEach(async () => {
  await client().exec(`
    TRUNCATE auth.identities, auth.delegation_grants, auth.delegation_grant_capabilities,
      auth.reach_envelopes, auth.reach_sender_blocks, kernel.event_subscription_log RESTART IDENTITY;
  `);
  await client().query("INSERT INTO auth.identities (id, tier) VALUES ($1, 'soft'), ($2, 'established')", [REQUESTER, STRANGER]);
  vi.stubEnv('AUTH_SERVICE_URL', 'https://kernel.test');
  vi.stubEnv('AUTH_INTERNAL_API_KEY', 'test-internal-key');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
});

afterAll(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await client().close();
});

async function publishAndCatchUp(agentDid = REQUESTER, event = REPLY) {
  await deliverToSubscribers(event);
  return catchUpSubscriptionEvents({ agentDid, cursor: 0n });
}

describe('private Reach reply subscription authorization', () => {
  it('delivers the full signed reply live and in catch-up to its signed requester, independent of trust tier', async () => {
    await seedGrant();
    await seedEnvelope();
    const result = await publishAndCatchUp();
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ payload: REPLY.payload, grantId: 'grant_1', issuer: PRINCIPAL, subject: PRINCIPAL });
    expect(fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string);
    expect(body).toMatchObject({ targetDid: REQUESTER, event: { payload: REPLY.payload, grantId: 'grant_1' } });
  });
  it.each([
    { issuer: STRANGER },
    { subject: STRANGER },
    { scope: 'other' },
    { payload: { ...REPLY.payload, requesterDid: STRANGER } },
    { payload: { ...REPLY.payload, signature: { keyId: 'other', alg: 'ed25519', sig: 'forged' } } },
  ])('requires the exact principal-signed committed event for live and catch-up (%j)', async (change) => {
    await seedGrant();
    await seedEnvelope();
    expect((await publishAndCatchUp(REQUESTER, { ...REPLY, ...change })).events).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { payload: { ...REPLY.payload, transcriptHash: 'other' } },
    { payload: { ...REPLY.payload, reachId: 'reach_other' } },
    { payload: { ...REPLY.payload, principalDid: STRANGER } },
    { payload: { ...REPLY.payload, requesterDid: STRANGER } },
    { issuer: STRANGER },
    { subject: STRANGER },
    { scope: 'other' },
    { type: 'agent.reach.delivered' },
  ])('binds the stored reply to its authoritative envelope columns (%j)', async (change) => {
    await seedGrant();
    const reply = { ...REPLY, ...change };
    await seedEnvelope({ reply });
    expect((await publishAndCatchUp(REQUESTER, reply)).events).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not let a replacement active broad grant revive a revoked original grant', async () => {
    await seedGrant();
    await seedGrant(REQUESTER, 'grant_replacement');
    await seedEnvelope();
    await client().exec("UPDATE auth.delegation_grants SET status = 'revoked' WHERE id = 'grant_1'");
    expect((await publishAndCatchUp()).events).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('allows explicit gate-backed own-envelope entitlement with no newly issued per-agent grant', async () => {
    await seedEnvelope({ grantId: null });
    const result = await publishAndCatchUp();
    expect(result.events[0]?.grantId).toBe('reach:reach_1');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('authorizes a committed verified-signed gate receipt without minting a local foreign identity', async () => {
    await seedEnvelope({ grantId: null });
    await client().query('DELETE FROM auth.identities WHERE id = $1', [REQUESTER]);
    expect((await publishAndCatchUp()).events).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('supports legacy verified signed deliveries without requesterAuthTier', async () => {
    await seedGrant();
    await seedEnvelope({ requesterAuthTier: undefined });
    expect((await publishAndCatchUp()).events).toHaveLength(1);
  });

  it.each(['oauth', 'bearer'])('does not treat %s credentials as signed despite a stored signature', async (requesterAuthTier) => {
    await seedGrant();
    await seedEnvelope({ requesterAuthTier });
    expect((await publishAndCatchUp()).events).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('never leaks a reply to an unrelated requester despite broad grants from the principal', async () => {
    await seedGrant();
    await seedGrant(STRANGER, 'grant_stranger');
    await seedEnvelope();
    const result = await publishAndCatchUp(STRANGER);
    expect(result.events).toEqual([]);
    expect(vi.mocked(fetch).mock.calls).toHaveLength(1);
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string).targetDid).toBe(REQUESTER);
  });

  it.each([
    ["UPDATE auth.delegation_grants SET status = 'revoked'"],
    ["UPDATE auth.delegation_grants SET expires_at = now() - interval '1 second'"],
    ["UPDATE auth.delegation_grant_capabilities SET status = 'revoked'"],
    ["UPDATE auth.delegation_grants SET audience = '{\"type\":\"dids\",\"values\":[\"did:imajin:elsewhere\"]}'"],
  ])('stops live and historical reply flow after authority changes: %s', async (query) => {
    await seedGrant();
    await seedEnvelope();
    await deliverToSubscribers(REPLY);
    vi.mocked(fetch).mockClear();
    await client().exec(query);
    const result = await publishAndCatchUp();
    expect(result.events).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['grant_1', null])('refuses sender blocks for %s admission', async (grantId) => {
    await seedGrant();
    await seedEnvelope({ grantId });
    await client().query('INSERT INTO auth.reach_sender_blocks VALUES ($1, $2)', [PRINCIPAL, REQUESTER]);
    expect((await publishAndCatchUp()).events).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['unknown', undefined])('refuses unknown or missing grant IDs (%s) rather than inferring gate admission', async (grantId) => {
    await seedEnvelope({ grantId });
    expect((await publishAndCatchUp()).events).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses uncommitted and forged signed event content even when reachId matches', async () => {
    await seedGrant();
    await seedEnvelope({ reply: undefined });
    expect((await publishAndCatchUp()).events).toEqual([]);
    await client().query("UPDATE auth.reach_envelopes SET envelope = jsonb_set(envelope, '{reply}', $1::jsonb)", [JSON.stringify(REPLY)]);
    const forged = { ...REPLY, payload: { ...REPLY.payload, message: 'forged' } };
    expect((await publishAndCatchUp(REQUESTER, forged)).events).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
    // The one historical row is the actual immutable reply, not the forgery.
    const result = await catchUpSubscriptionEvents({ agentDid: REQUESTER, cursor: 0n });
    expect(result.events[0]?.payload?.message).toBe('PRIVATE REPLY');
  });

  it('refuses suspended identities and invalid legacy signature provenance', async () => {
    await seedGrant();
    await seedEnvelope({ requesterAuthTier: undefined, requesterSignature: 'invalid' });
    expect(await loadReachReplyEntitlements(REQUESTER)).toEqual([]);
    await client().query("UPDATE auth.reach_envelopes SET envelope = jsonb_set(envelope, '{requesterAuthTier}', '\"signed\"')");
    await client().exec('UPDATE auth.identities SET suspended_at = now()');
    expect((await publishAndCatchUp()).events).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
