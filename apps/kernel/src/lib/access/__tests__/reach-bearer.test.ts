import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { NextRequest } from 'next/server';
import * as authSchema from '@/src/db/schemas/auth';
import * as accessSchema from '@/src/db/schemas/access';
import { defaultFrontDoorConfig } from '@/src/lib/jin/front-door';
import { emitAttestation, crypto as authCrypto } from '@imajin/auth';
import { publish } from '@imajin/bus';
import { hashToken } from '@/src/lib/mcp/oauth-config';
import { blockForeignAgentStub, introspectForeignAgentStub } from '@/src/lib/auth/foreign-agent-stub';
import { resolveReachRequester } from '@/src/lib/auth/reach-authority';
import { resolveDelegateGrantBearer } from '../delegate-grant';
import { POST as validateSession } from '@/app/auth/api/validate/route';
import { POST as knock } from '@/app/reach/[handle]/knock/route';
import { POST as send } from '@/app/reach/[handle]/route';
import { POST as reply } from '@/app/jin/api/reach/[reachId]/reply/route';
import { POST as status } from '@/app/auth/api/agents/[did]/reach/[reachId]/status/route';
import { getReachEnvelope } from '@/src/lib/auth/reach-envelope-store';
import { POST as mcp } from '@/app/reach/[handle]/mcp/route';
import { META_PROTOCOL_VERSION } from '@/src/lib/mcp/protocol';
import { reachReplyEvent, canonicalReachReply } from '@/src/lib/auth/reach-reply-wire';
import {
  issueReachBearer, resolveReachBearer, listReachBearerKnocks, blockReachBearerKnock,
  parseReachKnock, resolveReachRecipient,
} from '../reach-bearer';

const state = vi.hoisted(() => ({ db: null as unknown, client: null as unknown, log: vi.fn(), auth: vi.fn(), node: vi.fn() }));
vi.mock('@imajin/db', () => ({ getClient: () => state.client }));
vi.mock('@/src/db', async () => ({
  ...await import('@/src/db/schemas/auth'), ...await import('@/src/db/schemas/access'),
  get db() { return state.db; },
}));
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeDid: async () => 'did:imajin:node' }));
vi.mock('@/src/lib/mcp/tools', () => ({ ALL_TOOLS: [], toolByName: vi.fn() }));
vi.mock('@/src/lib/mcp/mcp-grant', () => ({ resolveActiveMcpGrant: vi.fn() }));
vi.mock('@imajin/auth', async (original) => ({
  ...await original<typeof import('@imajin/auth')>(), emitAttestation: vi.fn().mockResolvedValue({}), requireAuth: state.auth,
}));
vi.mock('@imajin/bus', () => ({
  publish: vi.fn().mockResolvedValue(undefined),
  broker: vi.fn().mockResolvedValue({ status: 'released', data: { contact_topics: { result: true } } }),
  isBrokerRelease: (result: { status: string }) => result.status === 'released',
}));
vi.mock('@imajin/config', async original => ({
  ...await original<typeof import('@imajin/config')>(),
  rateLimit: () => ({ limited: false, retryAfter: 0 }), getClientIP: () => '192.0.2.1',
}));
vi.mock('@/src/lib/auth/foreign-principal-stub', () => ({
  resolveOrMintForeignPrincipalStub: async () => ({ did: 'did:imajin:unverified-human' }),
}));
vi.mock('@/src/lib/vault/sealing', () => ({ getNodeSigningIdentity: state.node }));
vi.mock('@/src/lib/auth/emit-mechanical-attestation', () => ({
  prepareMechanicalAttestation: async (params: Record<string, unknown>, id: string) => ({
    ...params, id, issuerDid: 'did:imajin:node', signature: 'test-attestation-signature',
    cid: null, attestationStatus: null, issuedAt: new Date(),
  }),
}));
vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: state.log }),
  withLogger: (_name: string, fn: (request: unknown, ctx: unknown) => unknown) =>
    (request: unknown) => fn(request, { log: { error: state.log } }),
}));
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const pg = new PGlite();
const database = drizzle(pg, { schema: { ...authSchema, ...accessSchema } });
const owner = 'did:imajin:ryan';
const other = 'did:imajin:other';
const ownerKeys = authCrypto.generateKeypair();
const nodeKeys = authCrypto.generateKeypair();
const input = { agentLabel: 'Muse', onBehalfOf: { platform: 'muse', externalRef: 'opaque-alice', selfDescription: 'Alice' }, slidingWindowDays: 30 };
let failInsert = false;
let queries: string[] = [];

function executor(target: Pick<PGlite, 'query'>) {
  return { async unsafe(sql: string, params: unknown[] = []) {
    queries.push(sql);
    if (sql.includes('pg_advisory_xact_lock')) return [];
    if (failInsert && sql.includes('INSERT INTO auth.delegate_grant_bearers')) throw new Error('insert failed');
    return (await target.query(sql, params)).rows;
  } };
}

async function issued() {
  const result = await issueReachBearer(owner, input);
  if (!result.ok) throw new Error('Test fixture issuance failed');
  return result;
}

beforeAll(async () => {
  state.db = database;
  await pg.exec(`CREATE SCHEMA auth; CREATE SCHEMA kernel;
    CREATE TABLE kernel.bus_chain_configs (
      event_type text, scope text, reactors jsonb, enabled boolean, updated_at timestamptz,
      UNIQUE(event_type, scope)
    );
    CREATE TABLE auth.identities (
      id text PRIMARY KEY, scope text NOT NULL, subtype text, public_key text UNIQUE NOT NULL,
      tier text DEFAULT 'soft', metadata jsonb DEFAULT '{}', handle text, suspended_at timestamptz,
      name text, avatar_url text, avatar_asset_id text, upload_limit_mb integer, handle_claimed_at timestamptz,
      contact_email text, key_roles jsonb, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
    );
    CREATE TABLE auth.tokens (
      id text PRIMARY KEY, identity_id text, key_id text, key_role text, expires_at timestamptz,
      revoked_at timestamptz, created_at timestamptz, last_used_at timestamptz
    );
    CREATE TABLE auth.attestations (
      id text PRIMARY KEY, issuer_did text, subject_did text, type text, context_id text, context_type text,
      payload jsonb, signature text, cid text, attestation_status text, issued_at timestamptz
    );`);
  for (const name of ['0156_delegate_grant_bearers.sql', '0198_foreign_agent_stubs.sql', '0195_reach_envelopes.sql']) {
    await pg.exec(readFileSync(new URL(`../../../../../../migrations/${name}`, import.meta.url), 'utf8'));
  }
  state.client = {
    ...executor(pg),
    begin: (isolation: string, fn: (tx: ReturnType<typeof executor>) => Promise<unknown>) => {
      expect(isolation).toBe('isolation level read committed');
      return pg.transaction(tx => fn(executor(tx)));
    },
  };
});

describe('static-header HTTP round trip', () => {
  async function contact() {
    const response = await knock(new NextRequest('https://node.test/reach/ryan/knock', {
      method: 'POST', body: JSON.stringify(input),
    }), { params: Promise.resolve({ handle: 'ryan' }) });
    expect(response.status).toBe(201);
    const credential = await response.json();
    const delivery = await send(new NextRequest('https://node.test/reach/ryan', {
      method: 'POST', headers: { authorization: `Bearer ${credential.bearer}` },
      body: JSON.stringify({ topic: 'business_development', message: 'A stranger would like to talk', replyHandle: 'opaque:thread' }),
    }), { params: Promise.resolve({ handle: 'ryan' }) });
    expect(delivery.status).toBe(200);
    const { reachId } = await delivery.json();
    expect(reachId).toEqual(expect.any(String));
    return { ...credential, reachId };
  }
  function poll(bearer: string, reachId: string, principalDid = owner) {
    return status(new NextRequest('https://node.test/status', {
      method: 'POST', headers: { authorization: `Bearer ${bearer}` },
    }), { params: Promise.resolve({ did: principalDid, reachId }) });
  }
  async function answer(reachId: string) {
    const envelope = await getReachEnvelope({ principalDid: owner, reachId });
    if (!envelope) throw new Error('Missing delivered fixture');
    const event = reachReplyEvent(envelope, 'Yes, let us talk', new Date().toISOString());
    const signature = {
      alg: 'ed25519', keyId: ownerKeys.publicKey,
      sig: authCrypto.signSync(canonicalReachReply(event), ownerKeys.privateKey),
    };
    const response = await reply(new NextRequest('https://node.test/reply', {
      method: 'POST', body: JSON.stringify({ message: event.payload.message, issuedAt: event.payload.issuedAt, signature }),
    }), { params: Promise.resolve({ reachId }) });
    expect(response.status).toBe(200);
    return (await response.json()).reply;
  }

  function tool(name: string, args: Record<string, unknown>, bearer?: string, handle = 'ryan') {
    return mcp(new NextRequest(`https://node.test/reach/${handle}/mcp`, {
      method: 'POST',
      headers: {
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call', 'Mcp-Name': name,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name, arguments: args, _meta: { [META_PROTOCOL_VERSION]: '2026-07-28' } } }),
    }), { params: Promise.resolve({ handle }) });
  }

  async function toolContent(response: Response) {
    expect(response.status).toBe(200);
    const rpc = await response.json();
    expect(rpc.result.isError).toBe(false);
    return JSON.parse(rpc.result.content[0].text);
  }

  it('MCP: a stranger reads the card, knocks, asks, sends once and retrieves Ryan’s genuine signed reply', async () => {
    expect(await toolContent(await tool('reach_card', {}))).toMatchObject({
      principalDid: owner, topics: ['Business development'],
    });
    const knocked = await knock(new NextRequest('https://node.test/reach/ryan/knock', {
      method: 'POST', body: JSON.stringify(input),
    }), { params: Promise.resolve({ handle: 'ryan' }) });
    expect(knocked.status).toBe(201);
    const credential = await knocked.json();
    expect(await toolContent(await tool('reach_ask', { topic: 'Business development' }, credential.bearer)))
      .toMatchObject({ answer: true });
    const delivered = await toolContent(await tool('reach_send', {
      topic: 'Business development', message: 'Hello Ryan, from a stranger’s static-header agent',
    }, credential.bearer));
    expect(delivered).toMatchObject({ delivered: true, reachId: expect.any(String) });
    expect(await toolContent(await tool('reach_status', { reachId: delivered.reachId }, credential.bearer)))
      .toEqual({ reachId: delivered.reachId, state: 'delivered', reply: null });
    const signedReply = await answer(delivered.reachId);
    const receipt = await toolContent(await tool('reach_status', { reachId: delivered.reachId }, credential.bearer));
    expect(receipt).toEqual({ reachId: delivered.reachId, state: 'replied', reply: signedReply });
    const { signature, ...payload } = receipt.reply.payload;
    expect(authCrypto.verifySync(signature.sig, canonicalReachReply({ ...receipt.reply, payload }), ownerKeys.publicKey)).toBe(true);
    expect((await pg.query('SELECT reach_id FROM auth.reach_envelopes')).rows).toHaveLength(1);
  });

  it.each(['reach_ask', 'reach_send', 'reach_status'])('MCP: %s refuses real wrong-audience and revoked bearers with a scoped 401', async name => {
    const credential = await issued();
    const args = name === 'reach_status' ? { reachId: 'unknown' } : {
      topic: 'business_development', ...(name === 'reach_send' ? { message: 'Hello' } : {}),
    };
    const wrongAudience = await tool(name, args, credential.bearer, 'other');
    expect(wrongAudience.status).toBe(401);
    expect(wrongAudience.headers.get('www-authenticate')).toContain('/reach/other/mcp');
    await blockReachBearerKnock({ principalDid: owner, requestId: credential.requestId });
    const revoked = await tool(name, args, credential.bearer);
    expect(revoked.status).toBe(401);
    expect(revoked.headers.get('www-authenticate')).toContain('scope="agent:reach"');
    expect((await pg.query('SELECT reach_id FROM auth.reach_envelopes')).rows).toHaveLength(0);
    expect((await tool('reach_card', {}, credential.bearer)).status).toBe(200);
  });

  it('MCP: receipts remain requester-private even with a valid bearer for the same recipient', async () => {
    const first = await contact();
    const second = await issued();
    await answer(first.reachId);
    expect((await tool('reach_status', { reachId: first.reachId }, second.bearer)).status).toBe(404);
  });

  it('knocks, sends, receives the principal’s genuine signed reply through bearer-only polling', async () => {
    const credential = await contact();
    expect(await (await poll(credential.bearer, credential.reachId)).json())
      .toEqual({ reachId: credential.reachId, state: 'delivered', reply: null });
    const signedReply = await answer(credential.reachId);
    const response = await poll(credential.bearer, credential.reachId);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const receipt = await response.json();
    expect(receipt).toEqual({ reachId: credential.reachId, state: 'replied', reply: signedReply });
    const { signature, ...payload } = receipt.reply.payload;
    expect(authCrypto.verifySync(signature.sig, canonicalReachReply({ ...receipt.reply, payload }), ownerKeys.publicKey)).toBe(true);
    expect(JSON.stringify(receipt)).not.toContain('A stranger would like to talk');
    expect(JSON.stringify(receipt)).not.toContain('opaque:thread');
  });
  it('rejects principal A’s bearer on principal B’s HTTP status with 401', async () => {
    const credential = await contact();
    expect((await poll(credential.bearer, credential.reachId, other)).status).toBe(401);
  });
  it('returns 404 for another stub’s reachId even after a principal reply', async () => {
    const first = await contact();
    const second = await contact();
    await answer(first.reachId);
    expect((await poll(second.bearer, first.reachId)).status).toBe(404);
    expect((await poll(first.bearer, 'unknown')).status).toBe(404);
  });
  it('returns 401 for a revoked bearer, never a blocked receipt or existing reply', async () => {
    const credential = await contact();
    await answer(credential.reachId);
    await blockReachBearerKnock({ principalDid: owner, requestId: credential.requestId });
    const response = await poll(credential.bearer, credential.reachId);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Invalid reach credential' });
  });
  it('allows a still-valid sender-blocked credential to learn blocked but not read the reply or send', async () => {
    const credential = await contact();
    await answer(credential.reachId);
    await pg.query('INSERT INTO auth.reach_sender_blocks (principal_did, requester_did) VALUES ($1,$2)', [owner, credential.requesterDid]);
    expect(await resolveReachBearer(credential.bearer, owner)).toBeNull();
    const response = await poll(credential.bearer, credential.reachId);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ reachId: credential.reachId, state: 'blocked', reply: null });
    expect((await pg.query('SELECT status FROM auth.delegate_grant_bearers')).rows).toEqual([{ status: 'active' }]);
  });
  it.each(['expires_at', 'hard_cap_at'])('rejects a bearer past %s on status too', async column => {
    const credential = await contact();
    await pg.exec(`UPDATE auth.delegate_grant_bearers SET ${column} = now() - interval '1 second'`);
    expect((await poll(credential.bearer, credential.reachId)).status).toBe(401);
  });
});
afterAll(async () => { await pg.close(); });
beforeEach(async () => {
  await pg.exec('TRUNCATE auth.delegate_grant_bearers, auth.delegate_grant_requests, auth.foreign_agent_stubs, auth.identities, auth.reach_sender_blocks, auth.reach_envelopes, auth.attestations CASCADE');
  const gate = defaultFrontDoorConfig();
  gate.tiers.soft = true;
  gate.topics.business_development = { open: true, published: true, mode: 'deliver' };
  await database.insert(authSchema.identities).values([
    { id: owner, scope: 'actor', subtype: 'human', publicKey: ownerKeys.publicKey, handle: 'ryan',
      metadata: { agentReachGate: gate, agentReachTopics: ['business_development'] } },
    { id: other, scope: 'actor', subtype: 'human', publicKey: 'other', handle: 'other' },
  ]);
  failInsert = false;
  queries = [];
  vi.clearAllMocks();
  vi.mocked(emitAttestation).mockResolvedValue({} as never);
  vi.mocked(publish).mockResolvedValue(undefined);
  state.auth.mockResolvedValue({ identity: { id: owner, scope: 'actor', subtype: 'human' } });
  state.node.mockReturnValue({
    senderDid: 'did:imajin:node', senderPubkey: nodeKeys.publicKey, privateKeyHex: nodeKeys.privateKey,
  });
});

describe('reach bearer issuance (#2591)', () => {
  it('returns a new bearer only at issuance, stores only its hash, and emits a durable information-only knock', async () => {
    const result = await issued();
    expect(result).toMatchObject({ audience: owner, claimVerified: false, scopes: ['agent:reach'], surfaces: [`reach:${owner}`] });
    const rows = await pg.query('SELECT * FROM auth.delegate_grant_bearers');
    expect(rows.rows).toMatchObject([{ principal_did: result.requesterDid, token_hash: hashToken(result.bearer), approval_id: `reach-gate:${owner}` }]);
    expect(JSON.stringify(rows.rows)).not.toContain(result.bearer);
    const knocks = await listReachBearerKnocks(owner);
    expect(knocks).toMatchObject([{ requestId: result.requestId, agentLabel: 'Muse', onBehalfOf: input.onBehalfOf, claimVerified: false, status: 'active' }]);
    expect(JSON.stringify(knocks)).not.toContain(result.bearer);
    expect(JSON.stringify(knocks)).not.toContain(hashToken(result.bearer));
    expect(await listReachBearerKnocks(other)).toEqual([]);
    expect(emitAttestation).toHaveBeenCalledWith(expect.objectContaining({ type: 'access.knock', payload: expect.objectContaining({ claimVerified: false }) }));
    expect(emitAttestation).toHaveBeenCalledWith(expect.objectContaining({ type: 'access.bearer.issued', payload: expect.objectContaining({ authority: { type: 'reach-gate', principalDid: owner } }) }));
    expect(JSON.stringify(vi.mocked(emitAttestation).mock.calls)).not.toContain(result.bearer);
    expect(state.log).not.toHaveBeenCalled();
    const second = await issued();
    expect(second.bearer).not.toBe(result.bearer);
    expect(second.requesterDid).not.toBe(result.requesterDid);
    expect((await pg.query('SELECT id FROM auth.delegate_grant_bearers')).rows).toHaveLength(2);
  });

  it('authenticates only their stub for the exact recipient and cannot become a session or MCP credential', async () => {
    const result = await issued();
    expect(await resolveReachBearer(result.bearer, owner)).toEqual({
      requesterDid: result.requesterDid, bearerId: result.bearerId, onBehalfOf: input.onBehalfOf,
    });
    expect(await resolveReachBearer(result.bearer, other)).toBeNull();
    expect(await resolveDelegateGrantBearer(result.bearer, 'mcp')).toEqual({ ok: false, reason: 'surface_miss' });
    expect(await resolveDelegateGrantBearer(result.bearer, 'media')).toEqual({ ok: false, reason: 'surface_miss' });
    expect(await resolveReachRequester(result.requesterDid)).toBeNull();
    expect(await introspectForeignAgentStub(result.requesterDid, owner, 'vault:read')).toBe(false);
    const response = await validateSession(new NextRequest('https://example.test/auth/api/validate', {
      method: 'POST', body: JSON.stringify({ token: result.bearer }),
    }));
    expect(await response.json()).toMatchObject({ valid: false });
    expect(publish).toHaveBeenCalledWith('access.bearer.used', expect.objectContaining({
      subject: result.requesterDid, payload: expect.objectContaining({ surface: `reach:${owner}` }),
    }));
  });

  it('slides inactivity expiry atomically but never moves the hard cap', async () => {
    const result = await issued();
    await pg.exec("UPDATE auth.delegate_grant_bearers SET expires_at = now() + interval '1 day'");
    await resolveReachBearer(result.bearer, owner);
    const [row] = (await pg.query<{ expires_at: Date; hard_cap_at: Date; last_used_at: Date }>('SELECT * FROM auth.delegate_grant_bearers')).rows;
    expect(row.expires_at.getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    expect(row.hard_cap_at.toISOString()).toBe(result.hardCapAt);
    expect(row.last_used_at).toBeInstanceOf(Date);
    await pg.exec("UPDATE auth.delegate_grant_bearers SET hard_cap_at = now() + interval '2 days'");
    await resolveReachBearer(result.bearer, owner);
    const cap = (await pg.query<{ expires_at: Date; hard_cap_at: Date }>('SELECT * FROM auth.delegate_grant_bearers')).rows[0];
    expect(cap.expires_at).toEqual(cap.hard_cap_at);
    expect(queries.some(sql => sql.includes('LEAST(now()'))).toBe(true);
  });

  it.each(['expires_at', 'hard_cap_at'])('rejects expired %s without a use attestation or expiry extension', async column => {
    const result = await issued();
    await pg.exec(`UPDATE auth.delegate_grant_bearers SET ${column} = now() - interval '1 second'`);
    vi.mocked(emitAttestation).mockClear();
    expect(await resolveReachBearer(result.bearer, owner)).toBeNull();
    expect(emitAttestation).not.toHaveBeenCalled();
    expect((await listReachBearerKnocks(owner))[0].status).toBe('expired');
  });

  it('enforces a 90-day cap even with a 365-day window and ignores caller-requested capabilities/audience', async () => {
    const result = await issueReachBearer(owner, { ...input, slidingWindowDays: 365, scopes: ['vault:read'], audience: other } as never);
    expect(result).toMatchObject({ ok: true, audience: owner, scopes: ['agent:reach'] });
    if (!result.ok) throw new Error('Expected issuance');
    expect(result.expiresAt).toBe(result.hardCapAt);
  });

  it('block from the knock card revokes on the next call, clears the hash, is idempotent and owner-scoped', async () => {
    const result = await issued();
    expect(await blockReachBearerKnock({ principalDid: other, requestId: result.requestId })).toBe(false);
    expect(await resolveReachBearer(result.bearer, owner)).not.toBeNull();
    expect(await blockReachBearerKnock({ principalDid: owner, requestId: result.requestId })).toBe(true);
    expect(await blockReachBearerKnock({ principalDid: owner, requestId: result.requestId })).toBe(true);
    expect(await resolveReachBearer(result.bearer, owner)).toBeNull();
    expect((await pg.query('SELECT status, token_hash, revoked_by FROM auth.delegate_grant_bearers')).rows)
      .toEqual([{ status: 'revoked', token_hash: null, revoked_by: owner }]);
    expect((await listReachBearerKnocks(owner))[0].status).toBe('revoked');
    expect((await pg.query('SELECT * FROM auth.reach_sender_blocks')).rows).toHaveLength(1);
  });

  it('the existing foreign-agent block primitive also erases reach bearer hashes', async () => {
    const result = await issued();
    await blockForeignAgentStub(result.requesterDid, owner);
    expect(await resolveReachBearer(result.bearer, owner)).toBeNull();
    expect((await pg.query('SELECT token_hash FROM auth.delegate_grant_bearers')).rows).toEqual([{ token_hash: null }]);
  });

  it('checks live sender blocks, suspended recipients and missing/bad credentials', async () => {
    const result = await issued();
    expect(await resolveReachBearer('not-a-credential', owner)).toBeNull();
    await pg.query('INSERT INTO auth.reach_sender_blocks (principal_did, requester_did) VALUES ($1,$2)', [owner, result.requesterDid]);
    expect(await resolveReachBearer(result.bearer, owner)).toBeNull();
    await pg.exec('TRUNCATE auth.reach_sender_blocks');
    await pg.query('UPDATE auth.identities SET suspended_at = now() WHERE id = $1', [owner]);
    expect(await resolveReachBearer(result.bearer, owner)).toBeNull();
    expect(await resolveReachRecipient('ryan')).toBeNull();
  });

  it('denies a suspended requester stub without sliding its expiry or attesting a use', async () => {
    const result = await issued();
    await pg.query('UPDATE auth.identities SET suspended_at = now() WHERE id = $1', [result.requesterDid]);
    vi.mocked(emitAttestation).mockClear();
    expect(await resolveReachBearer(result.bearer, owner)).toBeNull();
    expect((await pg.query('SELECT last_used_at FROM auth.delegate_grant_bearers')).rows).toEqual([{ last_used_at: null }]);
    expect(emitAttestation).not.toHaveBeenCalled();
  });

  it('rolls back the stub, knock and hash together when issuance fails', async () => {
    failInsert = true;
    await expect(issueReachBearer(owner, input)).rejects.toThrow('insert failed');
    expect((await pg.query('SELECT * FROM auth.foreign_agent_stubs')).rows).toHaveLength(0);
    expect((await pg.query('SELECT * FROM auth.delegate_grant_requests')).rows).toHaveLength(0);
    expect((await pg.query("SELECT id FROM auth.identities WHERE subtype = 'foreign_agent_stub'")).rows).toHaveLength(0);
    expect(emitAttestation).not.toHaveBeenCalled();
  });

  it.each([null, {}, { agentReachGate: {} }, { agentReachGate: defaultFrontDoorConfig() }])('rejects an unauthored, malformed or closed soft gate: %j', async metadata => {
    await pg.query('UPDATE auth.identities SET metadata = $1::jsonb WHERE id = $2', [JSON.stringify(metadata), owner]);
    expect(await issueReachBearer(owner, input)).toMatchObject({ ok: false, status: 403 });
    expect((await pg.query('SELECT * FROM auth.foreign_agent_stubs')).rows).toHaveLength(0);
  });

  it('requires an existing active human recipient, resolves handle and DID to one audience', async () => {
    expect(await resolveReachRecipient('ryan')).toMatchObject({ id: owner });
    expect(await resolveReachRecipient(owner)).toMatchObject({ id: owner });
    expect(await resolveReachRecipient('unknown')).toBeNull();
    expect(await issueReachBearer('missing', input)).toMatchObject({ ok: false, status: 403 });
    await pg.query("UPDATE auth.identities SET subtype = 'agent' WHERE id = $1", [owner]);
    expect(await issueReachBearer(owner, input)).toMatchObject({ ok: false, status: 403 });
  });

  it('never logs plaintext even when attestation or publication fails', async () => {
    vi.mocked(emitAttestation).mockRejectedValue(new Error('transport failure'));
    vi.mocked(publish).mockRejectedValue(new Error('bus failure'));
    const result = await issued();
    expect(await resolveReachBearer(result.bearer, owner)).not.toBeNull();
    expect(state.log).toHaveBeenCalled();
    expect(JSON.stringify(state.log.mock.calls)).not.toContain(result.bearer);
    expect(JSON.stringify(state.log.mock.calls)).not.toContain(hashToken(result.bearer));
  });
});

describe('bounded knock claims', () => {
  it('normalizes supported inputs and labels the claim UNVERIFIED on validation errors', () => {
    expect(parseReachKnock({ agentLabel: ' Muse ', onBehalfOf: { platform: 'muse', externalRef: 'opaque' } }))
      .toMatchObject({ ok: true, input: { agentLabel: 'Muse', slidingWindowDays: 30 } });
    expect(parseReachKnock({ ...input, onBehalfOf: {} })).toMatchObject({ ok: false, error: expect.stringContaining('UNVERIFIED') });
  });
  it.each([null, [], 'a', {}, { ...input, agentLabel: ' ' }, { ...input, agentLabel: 'x'.repeat(201) },
    { ...input, onBehalfOf: null }, { ...input, onBehalfOf: { ...input.onBehalfOf, platform: 'x'.repeat(101) } },
    { ...input, onBehalfOf: { ...input.onBehalfOf, externalRef: '' } },
    { ...input, onBehalfOf: { ...input.onBehalfOf, selfDescription: 3 } },
    { ...input, slidingWindowDays: 31 }])('rejects malformed/broad input %j', value => {
    expect(parseReachKnock(value)).toMatchObject({ ok: false });
  });
  it('fails domain issuance validation before touching storage', async () => {
    expect(await issueReachBearer(owner, { ...input, agentLabel: '' })).toMatchObject({ ok: false, status: 400 });
  });
});
