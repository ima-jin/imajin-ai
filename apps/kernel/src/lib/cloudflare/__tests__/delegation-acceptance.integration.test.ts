import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Identity } from '@imajin/auth';
import type { VaultFile } from '@imajin/vault-core';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const h = vi.hoisted(() => ({
  db: null as unknown,
  identity: { id: 'did:imajin:human', scope: 'actor', subtype: 'human' } as Identity,
  vault: { version: 1, entries: [] } as VaultFile,
  log: vi.fn(), emit: vi.fn().mockResolvedValue(undefined), publish: vi.fn().mockResolvedValue(undefined),
  nodeDid: '',
}));
vi.mock('@/src/db', async () => {
  const auth = await import('@/src/db/schemas/auth');
  const vault = await import('@/src/db/schemas/vault');
  const approvals = await import('@/src/db/schemas/operator-approvals');
  const domains = await import('@/src/db/schemas/domains');
  const registry = await import('@/src/db/schemas/registry');
  const { forwardingDb } = await import('@/src/lib/notify/__tests__/pglite-connector-inbox-harness');
  return { ...auth, ...vault, ...approvals, ...domains, ...registry, db: forwardingDb(() => h.db) };
});
vi.mock('@imajin/auth', async original => ({
  ...await original<typeof import('@imajin/auth')>(),
  requireAuth: vi.fn(async () => ({ identity: h.identity })),
  requireAppAuth: vi.fn(async () => ({ error: 'Not an app credential', status: 401, notAppToken: true })),
  emitAttestation: h.emit,
}));
vi.mock('@imajin/bus', () => ({ publish: h.publish }));
vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ debug: h.log, info: h.log, warn: h.log, error: h.log }),
}));
vi.mock('@/src/lib/kernel/node-identity', () => ({
  getNodeDid: vi.fn(async () => h.nodeDid),
  getNodeDidFromConfig: vi.fn(async () => h.nodeDid),
}));
vi.mock('@/src/lib/notify/web-push', () => ({ pushWebNotificationToOperator: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/src/lib/notify/operator-approvals', async original => ({
  ...await original<typeof import('@/src/lib/notify/operator-approvals')>(),
  getOperatorDid: vi.fn().mockResolvedValue('did:imajin:human'),
}));
vi.mock('@/src/lib/vault/vault-repository', () => ({
  getVaultRepository: () => ({
    load: async () => structuredClone(h.vault),
    save: async (value: VaultFile) => { h.vault = structuredClone(value); },
  }),
}));

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { NextRequest } from 'next/server';
import { canonicalize, crypto, generateKeypair } from '@imajin/auth';
import {
  identities, identityMembers, attestations, delegationGrants,
  delegationGrantCapabilities, delegationGrantEvents,
} from '@/src/db/schemas/auth';
import { internalSecretProvisions, vaultDelegationGrants, vaultOwnerEnvelopes } from '@/src/db/schemas/vault';
import { operatorApprovals } from '@/src/db/schemas/operator-approvals';
import { domainBindings } from '@/src/db/schemas/domains';
import { POST as importCredential } from '@/app/api/vault/import/route';
import { POST as publicFetch } from '@/app/api/vault/delegation/grants/[grantId]/fetch/route';
import { PATCH as patchRecord } from '@/app/cloudflare/api/zones/[zoneId]/dns/[recordId]/route';
import { GET as zoneGrants, POST as delegateZone } from '@/app/jin/api/cloudflare-grants/route';
import { GET as receivedZoneGrants } from '@/app/cloudflare/api/grants/route';
import { DELETE as revokeZone } from '@/app/auth/api/grants/[grantId]/route';
import { POST as renewZone } from '@/app/auth/api/grants/[grantId]/renew/route';
import { decideOperatorApproval } from '@/src/lib/notify/operator-approvals-service';
import { executeVaultApproval } from '@/src/lib/vault/approvals-execution';
import { revokeGrant } from '@/src/lib/auth/grants';
import { getNodeSigningIdentity, _resetSealingCache } from '@/src/lib/vault/sealing';
import { fetchGrantSecret } from '@/src/lib/vault';

const HUMAN = 'did:imajin:human';
const GROUP = 'did:imajin:group-G';
const AGENT = 'did:imajin:agent-A';
const ZONE = 'a'.repeat(32);
const OTHER_ZONE = 'b'.repeat(32);
const RECORD = 'c'.repeat(32);
const personKeys = generateKeypair();
const nodeKeys = generateKeypair();
const tables = [
  identities, identityMembers, attestations, delegationGrants, delegationGrantCapabilities,
  delegationGrantEvents, internalSecretProvisions, vaultDelegationGrants, vaultOwnerEnvelopes, operatorApprovals, domainBindings,
];
let engine: PGlite;
let db: ReturnType<typeof drizzle>;
let token: string;
let visible: unknown[];
let providerWrites: number;
let providerFailure: boolean;
let proxied: boolean;

function createTable(table: PgTable): string {
  const config = getTableConfig(table);
  const columns = config.columns.map(column => {
    let defaultSql = '';
    if (['created_at', 'updated_at', 'issued_at'].includes(column.name)) defaultSql = ' DEFAULT now()';
    else if (typeof column.default === 'string') defaultSql = ` DEFAULT '${column.default}'`;
    else if (typeof column.default === 'boolean') defaultSql = ` DEFAULT ${column.default}`;
    else if (Array.isArray(column.default)) defaultSql = ` DEFAULT '[]'::jsonb`;
    return `"${column.name}" ${column.getSQLType()}${column.primary ? ' PRIMARY KEY' : ''}${column.notNull ? ' NOT NULL' : ''}${defaultSql}`;
  });
  return `CREATE TABLE "${config.schema}"."${config.name}" (${columns.join(',')})`;
}

beforeAll(async () => {
  engine = new PGlite();
  await engine.waitReady;
  await engine.exec('CREATE SCHEMA auth; CREATE SCHEMA kernel; CREATE SCHEMA operator;');
  for (const table of tables) await engine.exec(createTable(table));
  await engine.exec(`
    CREATE UNIQUE INDEX uniq_vwe ON kernel.vault_owner_envelopes (field,key_id);
    CREATE UNIQUE INDEX uniq_provision ON kernel.internal_secret_provisions (owner_did,purpose);
    CREATE UNIQUE INDEX uniq_vault_grant ON kernel.vault_delegation_grants (subject,granted_to,field,key_id) WHERE status='active';
    CREATE UNIQUE INDEX uniq_capability ON auth.delegation_grant_capabilities (grant_id,capability);
  `);
  db = drizzle(engine);
  h.db = db;
});
afterAll(async () => { await engine.close(); });
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv('AUTH_PRIVATE_KEY', nodeKeys.privateKey);
  vi.stubEnv('VAULT_OWNER_X_PUB', '');
  vi.stubEnv('VAULT_OWNER_ED_PUB', '');
  _resetSealingCache();
  h.nodeDid = getNodeSigningIdentity().senderDid;
  h.identity = { id: HUMAN, scope: 'actor', subtype: 'human' };
  h.vault = { version: 1, entries: [] };
  token = randomBytes(40).toString('base64url');
  visible = [];
  providerWrites = 0;
  providerFailure = false;
  proxied = false;
  for (const table of tables) await db.delete(table);
  await db.insert(identities).values([
    { id: HUMAN, scope: 'actor', subtype: 'human', publicKey: personKeys.publicKey, tier: 'established' },
    { id: GROUP, scope: 'business', subtype: 'organization', publicKey: generateKeypair().publicKey, tier: 'established' },
    { id: AGENT, scope: 'actor', subtype: 'agent', publicKey: generateKeypair().publicKey, tier: 'established' },
    { id: h.nodeDid, scope: 'actor', subtype: 'agent', publicKey: nodeKeys.publicKey, tier: 'established' },
  ]);
  await db.insert(identityMembers).values([
    { identityDid: GROUP, memberDid: HUMAN, role: 'admin' },
    // Legacy membership must NEVER rescue revoked Cloudflare authority.
    { identityDid: GROUP, memberDid: AGENT, role: 'agent' },
  ]);
  await db.insert(domainBindings).values(['example.com', 'example.net'].map(domain => ({
    id: `binding-${domain}`, domain, zoneOwner: GROUP, siteOwner: GROUP,
    method: 'dns-txt' as const, status: 'verified' as const,
    checkedAt: new Date(), verifiedAt: new Date(), attestation: { id: `verified-${domain}` },
  })));
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    expect(url.origin).toBe('https://api.cloudflare.com');
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${token}`);
    expect(init?.redirect).toBe('error');
    const suffix = url.pathname.replace(`/client/v4/zones/${ZONE}`, '');
    if (providerFailure) return Response.json({ success: false, errors: [{ message: token }] }, { status: 400 });
    if (!suffix || suffix === '/') return Response.json({ success: true, result: { id: ZONE, name: 'example.com' } });
    if (suffix === `/dns_records/${RECORD}`) {
      if (init?.method === 'PATCH') {
        providerWrites++;
        proxied = JSON.parse(init.body as string).proxied ?? proxied;
      }
      return Response.json({ success: true, result: {
        id: RECORD, type: 'A', name: 'www.example.com', content: '192.0.2.1', ttl: 1, proxied, proxiable: true,
      } });
    }
    throw new Error('Unexpected provider endpoint');
  }));
});
afterEach(async () => {
  const rows = await Promise.all(tables.map(table => db.select().from(table)));
  expect(JSON.stringify([visible, rows, h.vault, h.log.mock.calls, h.emit.mock.calls, h.publish.mock.calls]))
    .not.toContain(token);
  expect(Object.values(process.env)).not.toContain(token);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  _resetSealingCache();
});

async function sealForAgent() {
  const response = await importCredential(new NextRequest('https://kernel.test/api/vault/import', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ownerDid: GROUP, consumerDid: h.nodeDid, purpose: `dns.cloudflare:${ZONE}`, secret: token,
      cloudflare: { domain: 'example.com', zoneId: ZONE, granteeDid: AGENT, capabilities: ['cloudflare:dns'] },
    }),
  }));
  const body = await response.json();
  visible.push(body);
  expect(response.status).toBe(201);
  const [proposal] = await db.select().from(operatorApprovals).where(eq(operatorApprovals.proposalId, body.proposalId));
  const decidedAt = new Date().toISOString();
  const decision = await decideOperatorApproval({
    proposalId: body.proposalId, operatorDid: HUMAN, decision: 'approve', decidedAt,
    operatorSignature: {
      keyId: personKeys.publicKey, alg: 'ed25519',
      sig: crypto.signSync(canonicalize({ contentHash: proposal.contentHash!, decidedAt, decision: 'approve' }), personKeys.privateKey),
    },
  });
  visible.push(decision);
  expect(decision.ok).toBe(true);
  if (!decision.ok) throw new Error('Approval failed');
  const executed = await executeVaultApproval(decision.card);
  visible.push(executed);
  expect(executed).toEqual({ ok: true });
  const [grant] = await db.select().from(delegationGrants).where(and(
    eq(delegationGrants.delegatorDid, GROUP), eq(delegationGrants.agentDid, AGENT),
  ));
  expect(grant.audience).toEqual({ type: 'dids', values: [`did:imajin:cloudflare-${ZONE}`] });
  h.identity = { id: AGENT, scope: 'actor', subtype: 'agent' };
  return grant;
}

async function edit(zoneId = ZONE, domain = 'example.com') {
  const response = await patchRecord(new NextRequest(
    `https://kernel.test/cloudflare/api/zones/${zoneId}/dns/${RECORD}?domain=${domain}`, {
      method: 'PATCH', body: JSON.stringify({ ttl: 300 }), headers: { 'Content-Type': 'application/json' },
    },
  ), { params: Promise.resolve({ zoneId, recordId: RECORD }) });
  visible.push(await response.json());
  return response.status;
}

describe('issue #2995 operator acceptance across real import, vault and delegation primitives', () => {
  it('discovers only the grantee’s live zone metadata from the real applied import without fetching the credential', async () => {
    const grant = await sealForAgent();
    const request = new NextRequest(`https://kernel.test/cloudflare/api/grants?agentDid=${GROUP}`);
    const providerCalls = vi.mocked(fetch).mock.calls.length;
    const [before] = await db.select().from(vaultDelegationGrants);
    const result = await receivedZoneGrants(request);
    const body = await result.json();
    visible.push(body);
    expect(result.status).toBe(200);
    expect(body.grants).toEqual([{
      grantId: grant.id, agentDid: AGENT, delegatorDid: GROUP,
      audience: { type: 'dids', values: [`did:imajin:cloudflare-${ZONE}`] },
      zoneId: ZONE, domain: 'example.com', capabilities: ['cloudflare:dns'],
      issuedAt: grant.issuedAt.toISOString(), expiresAt: grant.expiresAt.toISOString(),
    }]);
    expect(vi.mocked(fetch).mock.calls).toHaveLength(providerCalls);
    expect(await db.select().from(vaultDelegationGrants)).toEqual([before]);
    expect((await db.select().from(delegationGrants))[0].lastUsedAt).toBeNull();
    h.identity = { id: HUMAN, scope: 'actor', subtype: 'human' };
    expect(await receivedZoneGrants(request).then(r => r.json())).toEqual({ grants: [] });
    h.identity = { id: AGENT, scope: 'actor', subtype: 'agent' };
    await db.update(vaultDelegationGrants).set({ status: 'revoked' });
    expect(await receivedZoneGrants(request).then(r => r.json())).toEqual({ grants: [] });
  });
  it('allows the current group human controller to grant, list, renew and revoke on /jin without repasting a token', async () => {
    await sealForAgent();
    h.identity = { id: HUMAN, scope: 'actor', subtype: 'human' };
    const url = `https://kernel.test/jin/api/cloudflare-grants?ownerDid=${GROUP}&domain=example.com&zoneId=${ZONE}`;
    const issued = await delegateZone(new NextRequest(url, { method: 'POST', body: JSON.stringify({
      ownerDid: GROUP, domain: 'example.com', zoneId: ZONE, granteeDid: 'did:imajin:member',
      capabilities: ['cloudflare:read'], ttlMs: 86400_000,
    }) }));
    const body = await issued.json();
    visible.push(body);
    expect(issued.status).toBe(201);
    const listed = await zoneGrants(new NextRequest(url));
    expect(listed.headers.get('Cache-Control')).toBe('no-store');
    expect((await listed.json()).grants).toHaveLength(2);
    const context = { params: Promise.resolve({ grantId: body.grant.grantId }) };
    const renewed = await renewZone(new NextRequest(url, { method: 'POST', body: '{}' }), context);
    expect(renewed.status).toBe(200);
    expect((await revokeZone(new NextRequest(url, { method: 'DELETE' }), context)).status).toBe(200);
    expect((await zoneGrants(new NextRequest(url)).then(result => result.json())).grants
      .find((grant: { grantId: string }) => grant.grantId === body.grant.grantId).revokedAt).not.toBeNull();
    h.identity = { id: AGENT, scope: 'actor', subtype: 'agent' };
    expect((await zoneGrants(new NextRequest(url))).status).toBe(403);
    expect((await delegateZone(new NextRequest(url, { method: 'POST', body: JSON.stringify({
      ownerDid: GROUP, domain: 'example.com', zoneId: ZONE, granteeDid: AGENT, capabilities: ['cloudflare:dns'],
    }) }))).status).toBe(403);
    expect(providerWrites).toBe(0);
  });

  it('rejects another seal for an active zone instead of creating ambiguous credential resolution', async () => {
    await sealForAgent();
    h.identity = { id: HUMAN, scope: 'actor', subtype: 'human' };
    const duplicate = await importCredential(new NextRequest('https://kernel.test/api/vault/import', {
      method: 'POST', body: JSON.stringify({ ownerDid: GROUP, secret: token,
        cloudflare: { domain: 'example.com', zoneId: ZONE, granteeDid: AGENT, capabilities: ['cloudflare:dns'] } }),
    }));
    visible.push(await duplicate.json());
    expect(duplicate.status).toBe(409);
    expect(await db.select().from(vaultDelegationGrants)).toHaveLength(1);
  });
  it('lets group G delegate DNS on Z to A, rejects another zone and immediately cuts A off on revoke', async () => {
    const grant = await sealForAgent();
    expect(await edit()).toBe(200);
    expect(providerWrites).toBe(1);
    expect(proxied).toBe(false);
    expect(await edit(OTHER_ZONE, 'example.net')).toBe(403);
    expect(providerWrites).toBe(1);
    expect(await revokeGrant({ grantId: grant.id, requestedBy: GROUP })).toMatchObject({ revoked: true });
    expect(await edit()).toBe(403);
    expect(providerWrites).toBe(1);
    const evidence = await db.select().from(attestations).where(eq(attestations.type, 'cloudflare.mutation'));
    expect(evidence.length).toBeGreaterThanOrEqual(2);
    for (const row of evidence) {
      expect(row.payload).toMatchObject({ actorDid: AGENT, onBehalfOf: GROUP, zoneId: ZONE });
      expect(row.issuerDid).toBe(h.nodeDid);
      expect(crypto.verifySync(row.signature, canonicalize({
        subject_did: row.subjectDid, type: row.type, context_id: row.contextId, context_type: row.contextType,
        payload: row.payload, issued_at: row.issuedAt.getTime(),
      }), nodeKeys.publicKey)).toBe(true);
    }
    expect(evidence.some(row => (row.payload as Record<string, unknown>).phase === 'success')).toBe(true);
  });

  it('never exposes the sealed token through a public vault fetch, even to the node DID', async () => {
    await sealForAgent();
    const [credential] = await db.select().from(vaultDelegationGrants).where(eq(vaultDelegationGrants.purpose, `dns.cloudflare:${ZONE}`));
    expect(credential.grantedTo).toBe(h.nodeDid);
    expect(await fetchGrantSecret({ grantId: credential.id, granteeDid: h.nodeDid })).toEqual({ status: 'not_grantee' });
    for (const did of [AGENT, h.nodeDid]) {
      h.identity = { id: did, scope: 'actor', subtype: 'agent' };
      const response = await publicFetch(new NextRequest('https://kernel.test/api/vault/fetch', { method: 'POST' }), {
        params: Promise.resolve({ grantId: credential.id }),
      });
      visible.push(await response.json());
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
    // Re-granting/relabeling cannot turn a private zone field into an export.
    await db.update(vaultDelegationGrants).set({ purpose: 'renamed', grantedTo: AGENT })
      .where(eq(vaultDelegationGrants.id, credential.id));
    expect(await fetchGrantSecret({ grantId: credential.id, granteeDid: AGENT })).toEqual({ status: 'not_grantee' });
  });

  it('returns 409 when the credential is absent and sanitizes reflected provider errors', async () => {
    await sealForAgent();
    providerFailure = true;
    expect(await edit()).toBe(502);
    expect(providerWrites).toBe(0);
    providerFailure = false;
    await db.update(vaultDelegationGrants).set({ status: 'revoked' })
      .where(eq(vaultDelegationGrants.purpose, `dns.cloudflare:${ZONE}`));
    expect(await edit()).toBe(409);
    expect(providerWrites).toBe(0);
  });
});
