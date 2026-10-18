import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { NextRequest } from 'next/server';
import { crypto as authCrypto, type Identity } from '@imajin/auth';
import * as schema from '@/src/db/schemas/auth';

const mocked = vi.hoisted(() => ({ db: null as unknown, client: vi.fn(), jwt: vi.fn() }));
vi.mock('@/src/db', async () => ({
  ...await import('@/src/db/schemas/auth'),
  ...await import('@/src/db/schemas/access'),
  get db() { return mocked.db; },
}));
vi.mock('@imajin/db', () => ({ getClient: mocked.client }));
vi.mock('@imajin/config', async (original) => ({
  ...await original<typeof import('@imajin/config')>(),
  rateLimit: () => ({ limited: false }),
}));
vi.mock('../grants', () => ({ introspectGrant: async () => ({ authorized: false }) }));
vi.mock('../foreign-principal-stub', () => ({
  resolveOrMintForeignPrincipalStub: async () => ({ did: 'did:imajin:claimed-human' }),
}));
vi.mock('../emit-mechanical-attestation', () => ({
  prepareMechanicalAttestation: async (input: Record<string, unknown>, id: string) => ({
    ...input, id, issuerDid: 'did:imajin:node', signature: 'test-attestation',
    cid: 'test-cid', attestationStatus: 'valid', issuedAt: new Date(),
  }),
}));
vi.mock('@/src/lib/vault/sealing', () => ({ getNodeSigningIdentity: () => ({
  senderDid: 'did:imajin:node', senderPubkey: principalKeys.publicKey, privateKeyHex: principalKeys.privateKey,
}) }));
vi.mock('@imajin/bus', () => ({
  publish: vi.fn().mockResolvedValue(undefined),
  broker: async () => ({ status: 'released', data: { contact_topics: { result: true } } }),
  isBrokerRelease: (result: { status: string }) => result.status === 'released',
}));
vi.mock('@/src/lib/auth/jwt', () => ({ verifyAppToken: mocked.jwt }));
vi.mock('@/src/lib/access/delegate-grant', () => ({
  resolveDelegateGrantBearer: async () => ({ ok: false, reason: 'unknown' }),
}));
vi.mock('@/src/lib/mcp/mcp-grant', () => ({ resolveActiveMcpGrant: vi.fn() }));
vi.mock('@/src/lib/mcp/tools', async () => {
  const { reachStatusTool } = await import('@/src/lib/mcp/tools/reach');
  return { ALL_TOOLS: [reachStatusTool], toolByName: (name: string) => name === reachStatusTool.name ? reachStatusTool : undefined };
});

import { reachPrincipal, reachTranscript, type ReachRequestInput } from '../agent-reach';
import { didFromPublicKey } from '../crypto';
import { blockForeignAgentStub, findForeignAgentStub } from '../foreign-agent-stub';
import { blockReachSender, getReachEnvelope } from '../reach-envelope-store';
import { replyToReach } from '../reach-reply-service';
import { canonicalReachReply, reachReplyEvent } from '../reach-reply-wire';
import { reachStatusTranscript, type SignedReachStatusRequest } from '../reach-status-auth';
import { defaultFrontDoorConfig } from '@/src/lib/jin/front-door';
import { POST as httpStatus } from '@/app/auth/api/agents/[did]/reach/[reachId]/status/route';
import { POST as mcpStatus } from '@/app/mcp/route';
import { getMcpResource } from '@/src/lib/mcp/oauth-config';

vi.setConfig({ hookTimeout: 30_000, testTimeout: 30_000 });
const principalKeys = authCrypto.generateKeypair();
const senderKeys = authCrypto.generateKeypair();
const otherKeys = authCrypto.generateKeypair();
const principalDid = 'did:imajin:ryan';
const principal: Identity = { id: principalDid, scope: 'actor', subtype: 'human' };
const derivedDid = didFromPublicKey(senderKeys.publicKey);
const webDid = 'did:web:foreign.example';
const pg = new PGlite();
const database = drizzle(pg, { schema });

function executor(target: Pick<PGlite, 'query'>) {
  return {
    async unsafe(sql: string, values: unknown[] = []) {
      // PGlite is single-connection: this suite proves persisted behavior,
      // not PostgreSQL multi-connection advisory-lock contention.
      if (sql.includes('pg_advisory_xact_lock')) return [];
      return (await target.query(sql, values)).rows;
    },
  };
}

beforeAll(async () => {
  mocked.db = database;
  mocked.client.mockReturnValue({
    ...executor(pg),
    begin: (_isolation: string, fn: (tx: ReturnType<typeof executor>) => Promise<unknown>) =>
      pg.transaction((tx) => fn(executor(tx))),
  });
  await pg.exec(`CREATE SCHEMA auth;
    CREATE TABLE auth.identities (
      registered_by_app_did text,
      id text PRIMARY KEY, public_key text NOT NULL UNIQUE, scope text NOT NULL,
      subtype text, tier text NOT NULL DEFAULT 'soft', metadata jsonb DEFAULT '{}', suspended_at timestamptz,
      handle text, name text, avatar_url text, avatar_asset_id text, upload_limit_mb integer,
      handle_claimed_at timestamptz, contact_email text, key_roles jsonb,
      created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
    );
    CREATE TABLE auth.attestations (
      id text PRIMARY KEY, issuer_did text, subject_did text, type text, context_id text, context_type text,
      payload jsonb, signature text, cid text, attestation_status text, issued_at timestamptz
    );
    CREATE TABLE auth.delegate_grant_bearers (
      principal_did text, surfaces jsonb, status text, token_hash text, revoked_at timestamptz, revoked_by text
    );`);
  for (const migration of ['0195_reach_envelopes.sql', '0198_foreign_agent_stubs.sql']) {
    await pg.exec(readFileSync(new URL(`../../../../../../migrations/${migration}`, import.meta.url), 'utf8'));
  }
});
afterAll(async () => { await pg.close(); });
beforeEach(async () => {
  await pg.exec('TRUNCATE auth.identities, auth.foreign_agent_stubs, auth.reach_envelopes, auth.reach_sender_blocks, auth.attestations CASCADE');
  const gate = defaultFrontDoorConfig();
  gate.tiers.soft = true;
  gate.topics.business_development = { open: true, published: true, mode: 'deliver' };
  await database.insert(schema.identities).values({
    id: principalDid, publicKey: principalKeys.publicKey, scope: 'actor', subtype: 'human',
    metadata: { agentReachGate: gate, agentReachTopics: ['business_development'] },
  });
  mocked.jwt.mockReset();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    verificationMethod: [{ publicKeyHex: senderKeys.publicKey }, { publicKeyHex: otherKeys.publicKey }],
  }))));
});
afterEach(() => { vi.unstubAllGlobals(); });

async function send(requesterDid: string) {
  const input: ReachRequestInput = {
    requesterDid, ...(requesterDid === webDid ? { publicKey: senderKeys.publicKey } : {}),
    onBehalfOf: { platform: 'foreign', externalRef: 'opaque-person' },
    purpose: 'agent.reach', field: 'contact_topics', predicate: 'contains', arg: 'business_development',
    message: 'Private first contact', topic: 'business_development', replyHandle: 'opaque:private-handle',
    issuedAt: new Date().toISOString(), signature: '',
  };
  input.signature = authCrypto.signSync(reachTranscript(principalDid, input), senderKeys.privateKey);
  const delivery = await reachPrincipal(principalDid, input);
  expect(delivery).toMatchObject({ delivered: true, reachId: expect.any(String) });
  if (!('reachId' in delivery)) throw new Error('Expected delivery');
  expect((await pg.query('SELECT id FROM auth.identities WHERE id = $1', [requesterDid])).rows).toHaveLength(0);
  expect(await findForeignAgentStub(requesterDid, principalDid)).toMatchObject({ revokedAt: null });
  return delivery.reachId;
}

async function reply(reachId: string) {
  const envelope = await getReachEnvelope({ principalDid, reachId });
  if (!envelope) throw new Error('Expected persisted envelope');
  const message = 'Ryan replies';
  const issuedAt = new Date().toISOString();
  const event = reachReplyEvent(envelope, message, issuedAt);
  const result = await replyToReach({
    identity: principal, reachId,
    input: {
      message, issuedAt,
      signature: {
        alg: 'ed25519', keyId: principalKeys.publicKey,
        sig: authCrypto.signSync(canonicalReachReply(event), principalKeys.privateKey),
      },
    },
  });
  if (!result.ok) throw new Error('Expected signed reply');
  return result.reply;
}

function signedStatus(requesterDid: string, reachId: string, keys = senderKeys): SignedReachStatusRequest {
  const fields = {
    requesterDid, issuedAt: new Date().toISOString(),
    ...(requesterDid === webDid ? { publicKey: keys.publicKey } : {}),
  };
  return { ...fields, signature: authCrypto.signSync(reachStatusTranscript(principalDid, reachId, fields), keys.privateKey) };
}

function pollHttp(reachId: string, input: SignedReachStatusRequest) {
  return httpStatus(new NextRequest('https://node.test/status', { method: 'POST', body: JSON.stringify(input) }), {
    params: Promise.resolve({ did: principalDid, reachId }),
  });
}

async function pollMcp(requesterDid: string, reachId: string) {
  // Existing transport authentication is outside this change; exercise the
  // actual dispatcher/reader with the verified token subject, not arguments.
  mocked.jwt.mockResolvedValue({
    sub: requesterDid, azp: 'did:imajin:foreign-client', aud: getMcpResource(), scope: 'discovery:read',
  });
  const response = await mcpStatus(new NextRequest('https://node.test/mcp', {
    method: 'POST', headers: { Authorization: 'Bearer test-token', 'x-acting-as': derivedDid },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'reach_status', arguments: { principalDid, reachId, requesterDid: derivedDid } },
    }),
  }));
  return (await response.json()).result;
}

describe.each([derivedDid, webDid])('foreign reach round trip: %s', (requesterDid) => {
  it('sends without registration or grant, then retrieves the exact principal-signed reply over HTTP and MCP', async () => {
    const reachId = await send(requesterDid);
    expect(await (await pollHttp(reachId, signedStatus(requesterDid, reachId))).json())
      .toEqual({ reachId, state: 'delivered', reply: null });
    const signedReply = await reply(reachId);
    const response = await pollHttp(reachId, signedStatus(requesterDid, reachId));
    expect(response.status).toBe(200);
    const status = await response.json();
    expect(status).toEqual({ reachId, state: 'replied', reply: signedReply });
    const { signature, ...payload } = status.reply.payload;
    expect(authCrypto.verifySync(signature.sig, canonicalReachReply({ ...status.reply, payload }), principalKeys.publicKey)).toBe(true);
    expect(JSON.parse((await pollMcp(requesterDid, reachId)).content[0].text)).toEqual(status);
    expect(JSON.stringify(status)).not.toContain('Private first contact');
    expect(JSON.stringify(status)).not.toContain('opaque:private-handle');
  });

  it('returns 401 for a wrong signing key and 404 for another authenticated requester', async () => {
    const reachId = await send(requesterDid);
    await reply(reachId);
    const wrong = signedStatus(requesterDid, reachId);
    wrong.signature = authCrypto.signSync(reachStatusTranscript(principalDid, reachId, wrong), otherKeys.privateKey);
    expect((await pollHttp(reachId, wrong)).status).toBe(401);
    const otherDid = didFromPublicKey(otherKeys.publicKey);
    const response = await pollHttp(reachId, signedStatus(otherDid, reachId, otherKeys));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Reach not found' });
    const mcp = await pollMcp(otherDid, reachId);
    expect(mcp.isError).toBe(true);
    expect(mcp.content[0].text).toContain('Reach not found');
    expect(JSON.stringify(mcp)).not.toContain('Ryan replies');
  });

  it.each(['sender block', 'stub revocation'])('still authenticates after %s but never returns the reply', async (mode) => {
    const reachId = await send(requesterDid);
    await reply(reachId);
    if (mode === 'sender block') await blockReachSender({ principalDid, requesterDid });
    else expect(await blockForeignAgentStub(requesterDid, principalDid)).toBe(true);
    const response = await pollHttp(reachId, signedStatus(requesterDid, reachId));
    expect(response.status).toBe(200);
    const blocked = { reachId, state: 'blocked', reply: null };
    expect(await response.json()).toEqual(blocked);
    expect(JSON.parse((await pollMcp(requesterDid, reachId)).content[0].text)).toEqual(blocked);
  });
});

it('rejects a tampered key even when both keys are verified by the did:web document', async () => {
  const reachId = await send(webDid);
  const input = signedStatus(webDid, reachId);
  expect((await pollHttp(reachId, signedStatus('did:web:unregistered.example', reachId))).status).toBe(401);
  expect((await pollHttp(reachId, { ...input, publicKey: otherKeys.publicKey })).status).toBe(401);
  expect((await pollHttp(reachId, { ...input, publicKey: senderKeys.publicKey.toUpperCase() })).status).toBe(401);
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ verificationMethod: [] })));
  expect((await pollHttp(reachId, input)).status).toBe(401);
});

it('preserves legacy transcripts and uses the registered key rather than a supplied override', async () => {
  const reachId = await send(derivedDid);
  await database.insert(schema.identities).values({
    id: derivedDid, publicKey: senderKeys.publicKey, scope: 'actor', subtype: 'agent',
  });
  const input = signedStatus(derivedDid, reachId);
  expect(JSON.parse(reachStatusTranscript(principalDid, reachId, input))).toEqual({
    type: 'reach_status', principalDid, reachId, requesterDid: derivedDid, issuedAt: input.issuedAt,
  });
  expect((await pollHttp(reachId, input)).status).toBe(200);
  const override = { ...input, publicKey: otherKeys.publicKey };
  override.signature = authCrypto.signSync(reachStatusTranscript(principalDid, reachId, override), otherKeys.privateKey);
  expect((await pollHttp(reachId, override)).status).toBe(401);
  await pg.query('UPDATE auth.identities SET suspended_at = now() WHERE id = $1', [derivedDid]);
  expect((await pollHttp(reachId, input)).status).toBe(401);
});

it('keeps receipt ownership exact even when a verified alias shares the same revoked stub', async () => {
  const webReach = await send(webDid);
  const derivedReach = await send(derivedDid);
  await reply(webReach);
  expect((await findForeignAgentStub(webDid, principalDid))?.stubDid)
    .toBe((await findForeignAgentStub(derivedDid, principalDid))?.stubDid);
  expect((await pollHttp(webReach, signedStatus(derivedDid, webReach))).status).toBe(404);
  expect(await blockForeignAgentStub(derivedDid, principalDid)).toBe(true);
  expect(await (await pollHttp(webReach, signedStatus(webDid, webReach))).json())
    .toEqual({ reachId: webReach, state: 'blocked', reply: null });
  expect(JSON.parse((await pollMcp(derivedDid, derivedReach)).content[0].text))
    .toEqual({ reachId: derivedReach, state: 'blocked', reply: null });
});
