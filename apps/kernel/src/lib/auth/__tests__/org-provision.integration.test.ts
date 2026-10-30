import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { is, SQL, eq } from 'drizzle-orm';
import { getTableConfig, PgDialect, type PgTable } from 'drizzle-orm/pg-core';
import { NextRequest } from 'next/server';
import { canonicalize, crypto, provideInternalApiKey, requireAuth, validateActingAs } from '@imajin/auth';
import * as schema from '@/src/db/schemas/auth';
import * as vaultSchema from '@/src/db/schemas/vault';
import { didFromPublicKey } from '../crypto';

const fixture = vi.hoisted(() => ({ db: null as unknown, nodeDid: vi.fn() }));
vi.mock('@/src/db', async () => ({
  ...await import('@/src/db/schemas/auth'),
  ...await import('@/src/db/schemas/vault'),
  ...await import('@/src/db/schemas/registry'),
  ...await import('@/src/db/schemas/media'),
  get db() { return fixture.db; },
}));
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeDid: fixture.nodeDid }));
vi.mock('@imajin/bus', () => ({
  publish: vi.fn().mockResolvedValue(undefined), registerReactor: vi.fn(),
}));

// Only auth-service transport, node identity and bus transport are substituted.
// Provisioning, minting, controller membership queries, grant signing, authority
// resolution and even the controller route's vault-backed internal key are real.
import { POST as provision } from '@/app/auth/api/agents/provision/route';
import { POST as createAgent, GET as listAgents } from '@/app/auth/api/agents/route';
import { POST as adoption } from '@/app/auth/api/agents/adopt/route';
import { GET as controller } from '@/app/auth/api/groups/[groupDid]/controllers/[controllerDid]/route';
import { POST as introspect } from '@/app/auth/api/internal/grants/introspect/route';
import { POST as verifyDelegation } from '@/app/auth/api/internal/verify-delegation/route';
import { resolveAgentAuthority } from '../agent-authority';
import { revokeGrant } from '../grants';
import { authorizeEvidencePublisher } from '@/src/lib/turn-evidence/authorize-publisher';
import { getInternalSecret } from '@/src/lib/vault/internal-secret';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const HUMAN = 'did:imajin:provision-human';
const ORG = 'did:imajin:provision-org';
const OTHER_ORG = 'did:imajin:provision-other-org';
const NODE = 'did:imajin:provision-node';
const nodeKeys = crypto.generateKeypair();
const pg = new PGlite();
const database = drizzle(pg, { schema });
let internalKey: string;

const authTables = [
  schema.identities, schema.identityMembers, schema.attestations, schema.agentProvisions,
  schema.delegationGrants, schema.delegationGrantCapabilities, schema.delegationGrantEvents,
  schema.challenges, schema.agentKnocks,
];

/** Derive columns/defaults from production, including any new grant outbox column. */
function createTable(table: PgTable) {
  const config = getTableConfig(table);
  const dialect = new PgDialect();
  const columns = config.columns.map(column => {
    let defaultSql = '';
    if (column.default !== undefined) {
      const value = is(column.default, SQL)
        ? dialect.sqlToQuery(column.default).sql
        : `'${String(typeof column.default === 'object' ? JSON.stringify(column.default) : column.default).replaceAll("'", "''")}'`;
      defaultSql = ` DEFAULT ${value}`;
    }
    return `"${column.name}" ${column.getSQLType()}${column.primary ? ' PRIMARY KEY' : ''}${column.notNull ? ' NOT NULL' : ''}${column.isUnique ? ' UNIQUE' : ''}${defaultSql}`;
  });

  return `CREATE TABLE "${config.schema}"."${config.name}" (${columns.join(', ')})`;
}

function request(path: string, options: {
  method?: string; actor?: string; actingAs?: string; actingFor?: string; body?: unknown;
} = {}) {
  return new NextRequest(`https://kernel.test/auth/api/${path}`, {
    method: options.method ?? 'POST',
    headers: {
      authorization: `Bearer ${options.actor ?? HUMAN}`,
      'content-type': 'application/json',
      ...(options.actingAs ? { 'x-acting-as': options.actingAs } : {}),
      ...(options.actingFor ? { 'x-acting-for': options.actingFor } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

async function upstream(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  if (url.pathname === '/api/validate') {
    const { token: actor } = JSON.parse(String(init?.body));
    const [identity] = await database.select().from(schema.identities).where(eq(schema.identities.id, actor));
    return Response.json({ valid: Boolean(identity), identity });
  }
  const match = /^\/api\/groups\/([^/]+)\/controllers\/([^/]+)$/.exec(url.pathname);
  if (match) {
    return controller(new NextRequest(url, init), {
      params: Promise.resolve({ groupDid: decodeURIComponent(match[1]), controllerDid: decodeURIComponent(match[2]) }),
    });
  }
  if (url.pathname === '/api/internal/verify-delegation') {
    return verifyDelegation(new NextRequest(url, init));
  }
  // The real vault self-provisioner emits its mechanical notification via
  // the upstream auth service; this response grants no membership/authority.
  if (url.pathname === '/api/attestations/internal') return Response.json({ id: 'fixture-notification' });
  throw new Error(`Unexpected upstream request: ${url.pathname}`);
}

beforeAll(async () => {
  await pg.waitReady;
  fixture.db = database;
  await pg.exec('CREATE SCHEMA auth; CREATE SCHEMA kernel;');
  for (const table of [...authTables, vaultSchema.internalSecretProvisions, vaultSchema.vaultDelegationGrants, vaultSchema.vaultOwnerEnvelopes]) {
    await pg.exec(createTable(table));
  }
  await pg.exec(`
    CREATE UNIQUE INDEX uniq_provision ON kernel.internal_secret_provisions (owner_did, purpose);
    CREATE UNIQUE INDEX uniq_vwe ON kernel.vault_owner_envelopes (field, key_id);
    CREATE UNIQUE INDEX uniq_vault_delegation_active ON kernel.vault_delegation_grants (subject, granted_to, field, key_id) WHERE status = 'active';
  `);
  vi.stubEnv('AUTH_PRIVATE_KEY', nodeKeys.privateKey);
  vi.stubEnv('VAULT_PATH', join(await mkdtemp(join(tmpdir(), 'org-provision-')), 'vault.json'));
  vi.stubEnv('VAULT_ALLOW_BOOTSTRAP', '1');
  vi.stubEnv('VAULT_OWNER_X_PUB', '');
  vi.stubEnv('VAULT_OWNER_ED_PUB', '');
  vi.stubGlobal('fetch', vi.fn(upstream));
  internalKey = await getInternalSecret('kernel.attestation-internal-api-key');
});

beforeEach(async () => {
  await pg.exec(`TRUNCATE ${authTables.map(table => `"auth"."${getTableConfig(table).name}"`).join(', ')} CASCADE`);
  await database.insert(schema.identities).values([
    { id: HUMAN, scope: 'actor', subtype: 'human', publicKey: crypto.generateKeypair().publicKey },
    { id: ORG, scope: 'business', publicKey: crypto.generateKeypair().publicKey },
    { id: OTHER_ORG, scope: 'community', publicKey: crypto.generateKeypair().publicKey },
  ]);
  await database.insert(schema.identityMembers).values({ identityDid: ORG, memberDid: HUMAN, role: 'owner' });
  fixture.nodeDid.mockResolvedValue(NODE);
  provideInternalApiKey(internalKey);
  vi.stubEnv('AUTH_INTERNAL_API_KEY', internalKey);
  vi.stubEnv('AUTH_SERVICE_URL', 'https://auth.fixture.test');
  vi.stubEnv('AGENT_AUTHORITY_MODE', 'grants-first');
  vi.stubGlobal('fetch', vi.fn(upstream));
});
afterAll(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await pg.close();
});

async function mintProvision(scopes = ['evidence:publish']) {
  const response = await provision(request('agents/provision', {
    actingAs: ORG,
    body: { servingDid: ORG, name: 'Org assistant', harness: 'nanoclaw', placement: 'local', scopes },
  }));
  expect(response.status).toBe(201);
  const { provision: row } = await response.json();
  expect(row.status, JSON.stringify(row.steps)).toBe('envelope_rendered');
  expect(row).toMatchObject({ servingDid: ORG, delegatorDid: ORG });
  expect(row.agentDid).toMatch(/^did:imajin:/);
  return row as { agentDid: string; grantId: string | null };
}

async function membershipsFor(agentDid: string) {
  return (await pg.query(
    'SELECT * FROM auth.identity_members WHERE identity_did = $1 OR member_did = $1', [agentDid],
  )).rows;
}

async function execute(agentDid: string, capability: string) {
  const response = await introspect(new NextRequest('https://kernel.test/auth/api/internal/grants/introspect', {
    method: 'POST', headers: { 'x-internal-key': internalKey },
    body: JSON.stringify({ agentDid, capability, targetDid: ORG }),
  }));
  expect(response.status).toBe(200);
  return response.json();
}

describe('real organization provisioning (#3001 ruling a)', () => {
  it('provisions an exact org handle, lists its grant under the org, and rejects a taken handle', async () => {
    const body = { servingDid: ORG, name: 'Artifact Jin', handle: 'artifact-jin', harness: 'nanoclaw', placement: 'local', scopes: ['messages:write'] };
    const response = await provision(request('agents/provision', { actingAs: ORG, body }));
    const { provision: row } = await response.json();
    expect(row).toMatchObject({ handle: 'artifact-jin', status: 'envelope_rendered' });
    const listed = await listAgents(request('agents', { method: 'GET', actingAs: ORG }));
    expect((await listed.json()).agents).toEqual([expect.objectContaining({ did: row.agentDid, role: 'grant', hasLegacyMembership: false })]);
    const personal = await listAgents(request('agents', { method: 'GET' }));
    expect((await personal.json()).agents).toEqual([]);
    const conflict = await provision(request('agents/provision', { actingAs: ORG, body }));
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error).toBe('Handle already taken');
  });

  it('adopts a historical orphan through real org auth, original key proof, grant signing and org listing', async () => {
    const agentKeys = crypto.generateKeypair();
    const agentDid = didFromPublicKey(agentKeys.publicKey);
    await database.insert(schema.identities).values({ id: agentDid, scope: 'actor', subtype: 'agent', publicKey: agentKeys.publicKey, handle: 'artifact-jin' });
    const challengeResponse = await adoption(request('agents/adopt', { actingAs: ORG,
      body: { action: 'challenge', agentDid, capabilities: ['messages:write'] } }));
    expect(challengeResponse.status).toBe(200);
    const proof = await challengeResponse.json();
    const response = await adoption(request('agents/adopt', { actingAs: ORG, body: {
      action: 'adopt', challengeId: proof.challengeId, signature: crypto.signSync(proof.challenge, agentKeys.privateKey),
    } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ did: agentDid, publicKey: agentKeys.publicKey, grant: { delegatorDid: ORG } });
    expect(await membershipsFor(agentDid)).toEqual([]);
    const [agent] = await database.select().from(schema.identities).where(eq(schema.identities.id, agentDid));
    expect(agent).toMatchObject({ id: agentDid, publicKey: agentKeys.publicKey, handle: 'artifact-jin' });
    const proofs = await database.select().from(schema.attestations);
    expect(proofs.map(row => row.type).sort()).toEqual(['agent.adopted', 'delegation.grant.issued']);
    for (const audit of proofs) {
      expect(crypto.verifySync(audit.signature, canonicalize({
        subject_did: audit.subjectDid, type: audit.type, context_id: audit.contextId,
        context_type: audit.contextType, payload: audit.payload, issued_at: audit.issuedAt.getTime(),
      }), nodeKeys.publicKey)).toBe(true);
    }
    const list = await listAgents(request('agents', { method: 'GET', actingAs: ORG }));
    expect((await list.json()).agents).toEqual([expect.objectContaining({ did: agentDid, role: 'grant', hasLegacyMembership: false })]);
  });

  it.each(['member', 'auth-excluded', 'removed'])('refuses adoption by a live %s org controller', async boundary => {
    await database.update(schema.identityMembers).set({
      ...(boundary === 'member' ? { role: 'member' } : {}),
      ...(boundary === 'auth-excluded' ? { allowedServices: ['pay'] } : {}),
      ...(boundary === 'removed' ? { removedAt: new Date() } : {}),
    }).where(eq(schema.identityMembers.memberDid, HUMAN));
    const response = await adoption(request('agents/adopt', { actingAs: ORG,
      body: { action: 'challenge', agentDid: 'did:imajin:historical', capabilities: ['messages:write'] } }));
    expect(response.status).toBe(403);
    expect(await database.select().from(schema.challenges)).toEqual([]);
  });
  it.each(['business', 'community', 'family'])('mints a stored %s serving identity with zero agent memberships', async scope => {
    await database.update(schema.identities).set({ scope }).where(eq(schema.identities.id, ORG));
    const { agentDid, grantId } = await mintProvision();
    expect(await membershipsFor(agentDid)).toEqual([]);
    const [grant] = await database.select().from(schema.delegationGrants);
    expect(grant).toMatchObject({ id: grantId, delegatorDid: ORG, agentDid });
    const [event] = await database.select().from(schema.delegationGrantEvents);
    expect(event).toMatchObject({ grantId, actorDid: HUMAN, event: 'issued' });
    const [audit] = await database.select().from(schema.attestations);
    expect(audit).toMatchObject({
      issuerDid: NODE, subjectDid: ORG, type: 'delegation.grant.issued',
      payload: { grantId, delegatorDid: ORG, actorDid: HUMAN, event: 'issued' },
    });
    const message = canonicalize({
      subject_did: audit.subjectDid, type: audit.type, context_id: audit.contextId,
      context_type: audit.contextType, payload: audit.payload, issued_at: audit.issuedAt.getTime(),
    });
    expect(crypto.verifySync(audit.signature, message, nodeKeys.publicKey)).toBe(true);
  });

  it('permits only granted onBehalfOf scope, never org act-as, and never falls back after revoke', async () => {
    const { agentDid, grantId } = await mintProvision();
    expect(await execute(agentDid, 'evidence:publish')).toMatchObject({ authorized: true, grantId, delegatorDid: ORG });
    expect(await authorizeEvidencePublisher(agentDid, ORG)).toEqual({ authorized: true, grantId });
    expect(await execute(agentDid, 'messages:write')).toMatchObject({ authorized: false });
    // Provision grants deliberately target all audiences. Claiming a different
    // onBehalfOf principal is instead checked by the principal-bound publisher.
    expect(await authorizeEvidencePublisher(agentDid, OTHER_ORG)).toEqual({ authorized: false });
    expect(await resolveAgentAuthority(agentDid, ORG)).toMatchObject({ allowed: true, via: 'grant' });
    expect(await validateActingAs(agentDid, ORG, 'auth')).toEqual({ valid: false });
    const controllerResponse = await controller(request('groups/check', {
      method: 'GET', actor: internalKey,
    }), { params: Promise.resolve({ groupDid: ORG, controllerDid: agentDid }) });
    expect(controllerResponse.status).toBe(200);
    expect(await controllerResponse.json()).toEqual({ valid: false });
    const impersonation = await requireAuth(request('agents', { actor: agentDid, actingAs: ORG }), { service: 'auth' });
    expect(impersonation).toMatchObject({ status: 403 });
    expect(await requireAuth(request('agents', { actor: agentDid, actingFor: ORG }))).toHaveProperty('identity.actingFor', ORG);
    expect(await requireAuth(request('agents', { actor: agentDid, actingFor: OTHER_ORG }))).toMatchObject({ status: 403 });

    expect(await revokeGrant({ grantId: grantId!, requestedBy: ORG, actorDid: HUMAN })).toEqual({ revoked: true });
    expect(await execute(agentDid, 'evidence:publish')).toMatchObject({ authorized: false });
    expect(await authorizeEvidencePublisher(agentDid, ORG)).toEqual({ authorized: false });
    expect(await resolveAgentAuthority(agentDid, ORG)).toEqual({ allowed: false, via: 'none' });
    expect(await requireAuth(request('agents', { actor: agentDid, actingFor: ORG }))).toMatchObject({ status: 403 });
    vi.stubEnv('AGENT_AUTHORITY_MODE', 'membership-only');
    expect(await resolveAgentAuthority(agentDid, ORG)).toEqual({ allowed: false, via: 'none' });
    vi.stubEnv('AUTH_INTERNAL_API_KEY', '');
    expect(await requireAuth(request('agents', { actor: agentDid, actingFor: ORG }))).toMatchObject({ status: 403 });
    expect(await membershipsFor(agentDid)).toEqual([]);
  });

  it('does not grant org authority when provisioning without scopes', async () => {
    const { agentDid, grantId } = await mintProvision([]);
    expect(grantId).toBeNull();
    expect(await membershipsFor(agentDid)).toEqual([]);
    expect(await resolveAgentAuthority(agentDid, ORG)).toEqual({ allowed: false, via: 'none' });
    expect(await validateActingAs(agentDid, ORG)).toEqual({ valid: false });
  });

  it('refuses direct org minting using stored org scope, ignoring a client personal-scope flag', async () => {
    const response = await createAgent(request('agents', {
      actingAs: ORG, body: { handle: 'direct-org-agent', scope: 'actor', isOrganization: false },
    }));
    expect(response.status).toBe(403);
    expect((await response.json()).error).toContain('Provision agent');
    expect(await database.select().from(schema.identities).where(eq(schema.identities.handle, 'direct-org-agent'))).toEqual([]);
  });

  it('preserves both legacy personal-agent rows through the real provision POST', async () => {
    const response = await provision(request('agents/provision', {
      body: { servingDid: HUMAN, name: 'Personal assistant', harness: 'nanoclaw', placement: 'local', scopes: [] },
    }));
    expect(response.status).toBe(201);
    const { provision: row } = await response.json();
    expect(row.status).toBe('envelope_rendered');
    expect(await membershipsFor(row.agentDid)).toEqual(expect.arrayContaining([
      expect.objectContaining({ identity_did: row.agentDid, member_did: HUMAN, role: 'owner' }),
      expect.objectContaining({ identity_did: HUMAN, member_did: row.agentDid, role: 'agent' }),
    ]));
    expect(await membershipsFor(row.agentDid)).toHaveLength(2);
  });
});
