import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { generateKeyPairSync, sign } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '@/src/db/schemas/auth';

const state = vi.hoisted(() => ({ db: null as unknown, grant: vi.fn(), persist: vi.fn(), node: vi.fn() }));
vi.mock('../reach-envelope-store', () => ({
  persistReachEnvelope: (...args: unknown[]) => state.persist(...args),
  markReachPublished: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../emit-mechanical-attestation', () => ({
  prepareMechanicalAttestation: vi.fn().mockResolvedValue({ id: 'att_reach_test' }),
}));
vi.mock('@/src/lib/vault/sealing', () => ({ getNodeSigningIdentity: () => state.node() }));
vi.mock('@/src/db', async () => {
  const tables = await import('@/src/db/schemas/auth');
  return { ...tables, get db() { return state.db; } };
});
vi.mock('../grants', () => ({ introspectGrant: (...args: unknown[]) => state.grant(...args) }));
vi.mock('../foreign-principal-stub', () => ({
  resolveOrMintForeignPrincipalStub: vi.fn().mockResolvedValue({ did: 'did:imajin:claimed-human' }),
}));
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeDid: async () => 'did:imajin:node' }));
vi.mock('@imajin/auth', async (original) => ({
  ...await original<typeof import('@imajin/auth')>(),
  emitAttestation: vi.fn().mockResolvedValue({}),
}));
vi.mock('@imajin/bus', () => ({
  publish: vi.fn().mockResolvedValue(undefined),
  broker: vi.fn().mockResolvedValue({ status: 'released', data: { contact_topics: { result: true } } }),
  isBrokerRelease: (result: { status: string }) => result.status === 'released',
}));
import { reachPrincipal, reachTranscript, type ReachRequestInput } from '../agent-reach';
import { didFromPublicKey, verifySignature } from '../crypto';
import { defaultFrontDoorConfig } from '@/src/lib/jin/front-door';
import {
  resolveOrMintForeignAgentStub, findForeignAgentStub, introspectForeignAgentStub,
  blockForeignAgentStub, promoteForeignAgentStub,
} from '../foreign-agent-stub';
import { resolveReachRequester } from '../reach-authority';
import { publish } from '@imajin/bus';

const pg = new PGlite();
const database = drizzle(pg, { schema });
const principalDid = 'did:imajin:ryan';
const otherPrincipal = 'did:imajin:other';
const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
const requesterDid = didFromPublicKey(publicKey);
const rotatedKeys = generateKeyPairSync('ed25519');
const rotatedKey = rotatedKeys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
const rotatedDid = didFromPublicKey(rotatedKey);

function signedInput(overrides: Partial<ReachRequestInput> = {}, signingKey = keys.privateKey): ReachRequestInput {
  const input: ReachRequestInput = {
    requesterDid, onBehalfOf: { platform: 'foreign', externalRef: 'someone' },
    purpose: 'agent.reach', field: 'contact_topics', predicate: 'contains', arg: 'business_development',
    issuedAt: new Date().toISOString(), signature: '', ...overrides,
  };
  input.signature = sign(null, Buffer.from(reachTranscript(principalDid, input)), signingKey).toString('hex');
  return input;
}

beforeAll(async () => {
  state.db = database;
  await pg.exec(`CREATE SCHEMA auth;
    CREATE TABLE auth.identities (
      id text PRIMARY KEY, public_key text NOT NULL UNIQUE, scope text NOT NULL,
      subtype text, tier text NOT NULL DEFAULT 'soft', metadata jsonb DEFAULT '{}', suspended_at timestamptz,
      handle text, name text, avatar_url text, avatar_asset_id text, upload_limit_mb integer,
      handle_claimed_at timestamptz, contact_email text, key_roles jsonb,
      created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
    );`);
  const migration = await readFile(new URL('../../../../../../migrations/0198_foreign_agent_stubs.sql', import.meta.url), 'utf8');
  await pg.exec(migration);
  // Plain-SQL runner migrations must also be safe on a second application.
  await pg.exec(migration);
});
afterAll(async () => { await pg.close(); });
beforeEach(async () => {
  await pg.exec('TRUNCATE auth.foreign_agent_stubs, auth.identities CASCADE');
  const gate = defaultFrontDoorConfig();
  gate.tiers.soft = true;
  gate.topics.business_development = { open: true, published: true, mode: 'deliver' };
  await database.insert(schema.identities).values([
    { id: principalDid, publicKey: 'principal', scope: 'actor', metadata: { agentReachGate: gate, agentReachTopics: ['business_development'] } },
    { id: otherPrincipal, publicKey: 'other', scope: 'actor' },
  ]);
  state.grant.mockReset().mockResolvedValue({ authorized: false });
  state.persist.mockReset().mockImplementation(async (envelope: Record<string, unknown>) => ({
    stored: true, reachId: envelope.reachId, published: false, signedEvent: envelope.signedEvent,
  }));
  state.node.mockReturnValue({
    senderDid: 'did:imajin:node', senderPubkey: rotatedKey,
    privateKeyHex: rotatedKeys.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('hex'),
  });
  vi.mocked(publish).mockClear();
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({
    verificationMethod: [{ publicKeyHex: publicKey }, { publicKeyHex: rotatedKey }],
  }), { status: 200 })));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('gate authority and foreign-agent stubs (#2590)', () => {
  it('delivers a stranger first contact with no grant through the signed envelope path', async () => {
    const input = signedInput({
      message: 'PRIVATE first-contact message', topic: 'business_development', replyHandle: 'PRIVATE reply handle',
    });
    expect(await reachPrincipal(principalDid, input)).toMatchObject({ delivered: true, reachId: expect.any(String) });
    expect(await findForeignAgentStub(requesterDid, principalDid)).toMatchObject({ capability: 'reach', principalDid });
    expect(state.persist).toHaveBeenCalledWith(expect.objectContaining({
      message: input.message, replyHandle: input.replyHandle, requesterSignature: input.signature, grantId: null,
    }));
    expect(publish).toHaveBeenCalledWith('agent.reach.delivered', expect.objectContaining({
      subject: principalDid, payload: expect.objectContaining({ grantId: null, requesterTier: 'soft', claimVerified: false }),
    }));
  });
  it('succeeds on first signed call without identity, knock, connection or grant; repeat calls reuse the stub', async () => {
    expect(await reachPrincipal(principalDid, signedInput())).toMatchObject({ answer: true });
    const first = await findForeignAgentStub(requesterDid, principalDid);
    expect(first).toMatchObject({ capability: 'reach', principalDid, requesterDid, promotedTo: null, revokedAt: null });
    expect(await reachPrincipal(principalDid, signedInput())).toMatchObject({ answer: true });
    expect((await findForeignAgentStub(requesterDid, principalDid))?.stubDid).toBe(first?.stubDid);
    const identities = await pg.query('SELECT * FROM auth.identities WHERE id = $1', [first?.stubDid]);
    expect(identities.rows).toMatchObject([{
      subtype: 'foreign_agent_stub', tier: 'soft',
      metadata: { stub: true, capabilities: ['reach'], principalDid },
    }]);
    expect(await resolveReachRequester(first!.stubDid)).toBeNull();
    expect(await resolveReachRequester(requesterDid)).toMatchObject({ publicKey, tier: 'soft' });
    const fullIdentity = await pg.query('SELECT id FROM auth.identities WHERE id = $1', [requesterDid]);
    expect(fullIdentity.rows).toHaveLength(0);
  });

  it('admits a verified did:web with no pre-existing relationship, but rejects unverified keys', async () => {
    const input = signedInput({ requesterDid: 'did:web:agent.example', publicKey });
    expect(await reachPrincipal(principalDid, input)).toMatchObject({ answer: true });
    expect(fetch).toHaveBeenCalled();
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ verificationMethod: [] })));
    expect(await reachPrincipal(principalDid, input)).toMatchObject({ denied: true, reason: 'requester_unknown' });
    expect(await resolveReachRequester('did:web:agent.example')).toBeNull();
  });

  it('never mints for a forged or stale signature', async () => {
    const forged = signedInput();
    forged.signature = '0'.repeat(128);
    expect(await reachPrincipal(principalDid, forged)).toMatchObject({ denied: true, reason: 'invalid_signature' });
    expect(await reachPrincipal(principalDid, signedInput({ issuedAt: '2000-01-01T00:00:00Z' }))).toMatchObject({ denied: true, reason: 'invalid_signature' });
    expect((await pg.query('SELECT * FROM auth.foreign_agent_stubs')).rows).toHaveLength(0);
  });

  it('has exactly one capability, one audience, and a non-signable normal-auth key', async () => {
    const stub = await resolveOrMintForeignAgentStub(requesterDid, principalDid, publicKey);
    expect(await introspectForeignAgentStub(stub!.stubDid, principalDid, 'reach')).toBe(true);
    expect(await introspectForeignAgentStub(stub!.stubDid, otherPrincipal, 'reach')).toBe(false);
    expect(await introspectForeignAgentStub(stub!.stubDid, principalDid, 'vault:read')).toBe(false);
    expect(await introspectForeignAgentStub('missing', principalDid, 'reach')).toBe(false);
    const row = await pg.query<{ public_key: string }>('SELECT public_key FROM auth.identities WHERE id = $1', [stub!.stubDid]);
    expect(await verifySignature('login', sign(null, Buffer.from('login'), keys.privateKey).toString('hex'), row.rows[0].public_key)).toBe(false);
    await expect(pg.query("UPDATE auth.foreign_agent_stubs SET capability = 'vault:read'")).rejects.toThrow();
    const other = await resolveOrMintForeignAgentStub(requesterDid, otherPrincipal, publicKey);
    expect(other!.stubDid).not.toBe(stub!.stubDid);
  });

  it('blocks the credential on the next call, without reminting or evasion via a DID alias or explicit grant', async () => {
    const web = signedInput({ requesterDid: 'did:web:agent.example', publicKey });
    expect(await reachPrincipal(principalDid, web)).toMatchObject({ answer: true });
    const stub = await findForeignAgentStub(web.requesterDid, principalDid);
    expect(await blockForeignAgentStub(web.requesterDid, otherPrincipal)).toBe(false);
    expect(await blockForeignAgentStub(stub!.stubDid, principalDid)).toBe(true);
    state.grant.mockResolvedValue({ authorized: true, grantId: 'override' });
    expect(await reachPrincipal(principalDid, signedInput())).toMatchObject({ denied: true, reason: 'unauthorized' });
    expect(await reachPrincipal(principalDid, web)).toMatchObject({ denied: true, reason: 'unauthorized' });
    expect(await introspectForeignAgentStub(stub!.stubDid, principalDid, 'reach')).toBe(false);
    expect((await resolveOrMintForeignAgentStub(requesterDid, principalDid, publicKey))?.revokedAt).not.toBeNull();
    expect((await pg.query('SELECT * FROM auth.foreign_agent_stubs')).rows).toHaveLength(1);
  });

  it('links promotion to an accepted full identity without clearing a block or conferring extra capability', async () => {
    const stub = await resolveOrMintForeignAgentStub('did:web:agent.example', principalDid, publicKey);
    await database.insert(schema.identities).values({ id: requesterDid, publicKey, scope: 'actor', subtype: 'agent', tier: 'preliminary' });
    await blockForeignAgentStub(stub!.stubDid, principalDid);
    await promoteForeignAgentStub(requesterDid, principalDid, requesterDid, publicKey);
    const promoted = await findForeignAgentStub('did:web:agent.example', principalDid);
    expect(promoted).toMatchObject({ promotedTo: requesterDid, capability: 'reach' });
    expect(promoted?.revokedAt).not.toBeNull();
    expect(await blockForeignAgentStub(requesterDid, principalDid)).toBe(true);
  });

  it('remembers verified DID aliases so the operator can block the sender they actually see', async () => {
    expect(await reachPrincipal(principalDid, signedInput({ requesterDid: 'did:web:first.example', publicKey }))).toMatchObject({ answer: true });
    expect(await reachPrincipal(principalDid, signedInput())).toMatchObject({ answer: true });
    expect(await reachPrincipal(principalDid, signedInput({ requesterDid: 'did:web:second.example', publicKey }))).toMatchObject({ answer: true });
    const alias = await findForeignAgentStub('did:web:second.example', principalDid);
    expect(alias?.requesterAliases).toEqual(expect.arrayContaining([requesterDid, 'did:web:first.example', 'did:web:second.example']));
    expect(await blockForeignAgentStub('did:web:second.example', principalDid)).toBe(true);
    expect(await reachPrincipal(principalDid, signedInput())).toMatchObject({ denied: true, reason: 'unauthorized' });
  });

  it('also gives legacy grant callers durable sender state so a block wins over an active grant', async () => {
    state.grant.mockResolvedValue({ authorized: true, grantId: 'legacy' });
    expect(await reachPrincipal(principalDid, signedInput())).toMatchObject({ answer: true });
    expect(await blockForeignAgentStub(requesterDid, principalDid)).toBe(true);
    expect(await reachPrincipal(principalDid, signedInput())).toMatchObject({ denied: true, reason: 'unauthorized' });
  });

  it.each([{ purpose: 'vault.read' }, { field: 'contact_email' }])('never uses tier admission to authorize another resource: %j', async (overrides) => {
    expect(await reachPrincipal(principalDid, signedInput(overrides))).toMatchObject({ denied: true, reason: 'unauthorized' });
    expect((await pg.query('SELECT * FROM auth.foreign_agent_stubs')).rows).toHaveLength(0);
  });

  it('coalesces concurrent first contact and key rotation without duplicating a requester stub', async () => {
    const stubs = await Promise.all([
      resolveOrMintForeignAgentStub(requesterDid, principalDid, publicKey),
      resolveOrMintForeignAgentStub('did:web:alias.example', principalDid, publicKey),
    ]);
    expect(stubs[0]?.stubDid).toBe(stubs[1]?.stubDid);
    const rotated = await resolveOrMintForeignAgentStub(requesterDid, principalDid, 'b'.repeat(64));
    expect(rotated?.stubDid).toBe(stubs[0]?.stubDid);
    expect((await pg.query('SELECT * FROM auth.foreign_agent_stubs')).rows).toHaveLength(1);
    expect((await pg.query("SELECT * FROM auth.identities WHERE subtype = 'foreign_agent_stub'")).rows).toHaveLength(1);
  });

  it('refuses suspended identities and does not trust a caller-provided signing key over a registered key', async () => {
    await database.insert(schema.identities).values({ id: requesterDid, scope: 'actor', publicKey, suspendedAt: new Date() });
    expect(await resolveReachRequester(requesterDid, 'b'.repeat(64))).toBeNull();
  });

  it('accrues rotated signing keys, joins prior credentials, and blocks the whole group even by an old stub ID', async () => {
    const webDid = 'did:web:rotating.example';
    expect(await reachPrincipal(principalDid, signedInput({ requesterDid: rotatedDid }, rotatedKeys.privateKey))).toMatchObject({ answer: true });
    expect(await reachPrincipal(principalDid, signedInput({ requesterDid: webDid, publicKey }))).toMatchObject({ answer: true });
    const original = await findForeignAgentStub(webDid, principalDid);
    expect(await reachPrincipal(principalDid, signedInput({ requesterDid: webDid, publicKey: rotatedKey }, rotatedKeys.privateKey))).toMatchObject({ answer: true });
    const rotated = await findForeignAgentStub(rotatedDid, principalDid);
    expect(rotated?.signerAliases).toEqual(expect.arrayContaining([publicKey, rotatedKey]));
    expect(await blockForeignAgentStub(original!.stubDid, principalDid)).toBe(true);
    expect(await introspectForeignAgentStub(rotated!.stubDid, principalDid, 'reach')).toBe(false);
    expect(await reachPrincipal(principalDid, signedInput({ requesterDid: rotatedDid }, rotatedKeys.privateKey))).toMatchObject({ denied: true });
  });

  it('always chooses a matching tombstone over another active credential during rotation', async () => {
    await resolveOrMintForeignAgentStub(rotatedDid, principalDid, rotatedKey);
    await resolveOrMintForeignAgentStub('did:web:blocked.example', principalDid, publicKey);
    await blockForeignAgentStub('did:web:blocked.example', principalDid);
    expect(await reachPrincipal(principalDid, signedInput({
      requesterDid: 'did:web:blocked.example', publicKey: rotatedKey,
    }, rotatedKeys.privateKey))).toMatchObject({ denied: true, reason: 'unauthorized' });
  });

  it('serializes simultaneous first calls from two verified keys of the same web DID without orphan identities', async () => {
    const webDid = 'did:web:concurrent.example';
    const stubs = await Promise.all([
      resolveOrMintForeignAgentStub(webDid, principalDid, publicKey),
      resolveOrMintForeignAgentStub(webDid, principalDid, rotatedKey),
    ]);
    expect(stubs[0]?.stubDid).toBe(stubs[1]?.stubDid);
    expect((await findForeignAgentStub(rotatedDid, principalDid, rotatedKey))?.signerAliases).toEqual(expect.arrayContaining([publicKey, rotatedKey]));
    expect((await pg.query("SELECT * FROM auth.identities WHERE subtype = 'foreign_agent_stub'")).rows).toHaveLength(1);
    expect(await blockForeignAgentStub(webDid, principalDid)).toBe(true);
    expect(await reachPrincipal(principalDid, signedInput({ requesterDid: rotatedDid }, rotatedKeys.privateKey))).toMatchObject({ denied: true });
  });

  it('fails closed without an authored tier gate, for unadmitted tiers and non-reach resources', async () => {
    await database.update(schema.identities).set({ metadata: {} });
    expect(await reachPrincipal(principalDid, signedInput())).toMatchObject({ denied: true, reason: 'unauthorized' });
    expect((await pg.query('SELECT * FROM auth.foreign_agent_stubs')).rows).toHaveLength(0);
    state.grant.mockResolvedValue({ authorized: true, grantId: 'legacy' });
    expect(await reachPrincipal(principalDid, signedInput())).toMatchObject({ answer: true });
  });
});
