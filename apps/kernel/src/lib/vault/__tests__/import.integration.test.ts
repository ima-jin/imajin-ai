import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Identity } from '@imajin/auth';
import type { VaultFile } from '@imajin/vault-core';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const h = vi.hoisted(() => ({
  db: null as unknown,
  identity: { id: 'did:imajin:human', scope: 'actor', subtype: 'human' } as Identity,
  vault: { version: 1, entries: [] } as VaultFile,
  log: vi.fn(), emit: vi.fn().mockResolvedValue(undefined), publish: vi.fn().mockResolvedValue(undefined),
  saveError: null as Error | null,
}));
vi.mock('@/src/db', async () => {
  const auth = await import('@/src/db/schemas/auth');
  const vault = await import('@/src/db/schemas/vault');
  const approvals = await import('@/src/db/schemas/operator-approvals');
  const { forwardingDb } = await import('@/src/lib/notify/__tests__/pglite-connector-inbox-harness');
  return { ...auth, ...vault, ...approvals, db: forwardingDb(() => h.db) };
});
vi.mock('@imajin/auth', async importOriginal => ({
  ...await importOriginal<typeof import('@imajin/auth')>(),
  requireAuth: vi.fn(async () => ({ identity: h.identity })), emitAttestation: h.emit,
}));
vi.mock('@imajin/bus', () => ({ publish: h.publish }));
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeDid: vi.fn().mockResolvedValue('did:imajin:node') }));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ debug: h.log, info: h.log, warn: h.log, error: h.log }) }));
vi.mock('@/src/lib/notify/web-push', () => ({ pushWebNotificationToOperator: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/src/lib/notify/operator-approvals', async importOriginal => ({
  ...await importOriginal<typeof import('@/src/lib/notify/operator-approvals')>(),
  getOperatorDid: vi.fn().mockResolvedValue('did:imajin:human'),
}));
vi.mock('../vault-repository', () => ({
  getVaultRepository: () => ({
    load: async () => structuredClone(h.vault),
    save: async (vault: VaultFile) => {
      if (h.saveError) throw h.saveError;
      h.vault = structuredClone(vault);
    },
  }),
}));

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { identities, identityMembers } from '@/src/db/schemas/auth';
import { internalSecretProvisions, vaultDelegationGrants, vaultOwnerEnvelopes } from '@/src/db/schemas/vault';
import { operatorApprovals } from '@/src/db/schemas/operator-approvals';
import { NextRequest } from 'next/server';
import { GET, POST } from '@/app/api/vault/import/route';
import { GET as listRoute } from '@/app/api/vault/delegation/grants/route';
import { POST as fetchRoute } from '@/app/api/vault/delegation/grants/[grantId]/fetch/route';
import { POST as ackRoute } from '@/app/api/vault/delegation/grants/[grantId]/ack/route';
import { canonicalize, crypto, generateKeypair, loadFromVault } from '@imajin/auth';
import { decideOperatorApproval, recordApprovalRequested } from '@/src/lib/notify/operator-approvals-service';
import { executeVaultApproval } from '../approvals-execution';
import { executeImportApproval, importedKeyField, listImportedKeyCards, validateImportBody } from '../import';
import { importFingerprint, stageImport } from '../import-staging';
import { listImportOwners, canExecuteImport } from '../import-authority';
import { getNodeSigningIdentity } from '../sealing';
import { fetchGrantSecret, listGrantsForGrantee, vaultService } from '../index';

const HUMAN = 'did:imajin:human';
const ORG = 'did:imajin:organization';
const AGENT = 'did:imajin:agent';
const STRANGER = 'did:imajin:stranger';
const personKeys = generateKeypair();
const agentKeys = generateKeypair();
const tables = [identities, identityMembers, internalSecretProvisions, vaultDelegationGrants, vaultOwnerEnvelopes, operatorApprovals];
let client: PGlite;
let db: ReturnType<typeof drizzle>;

/** Real schema columns, defaults needed by these rails, and production uniqueness constraints. */
function createTable(table: PgTable) {
  const config = getTableConfig(table);
  const columns = config.columns.map(column => {
    let defaultSql = '';
    if (column.name === 'created_at' || column.name === 'updated_at') defaultSql = ' DEFAULT now()';
    else if (typeof column.default === 'string') defaultSql = ` DEFAULT '${column.default}'`;
    else if (typeof column.default === 'boolean') defaultSql = ` DEFAULT ${column.default}`;
    else if (Array.isArray(column.default)) defaultSql = ` DEFAULT '[]'::jsonb`;
    return `"${column.name}" ${column.getSQLType()}${column.primary ? ' PRIMARY KEY' : ''}${column.notNull ? ' NOT NULL' : ''}${defaultSql}`;
  });
  return `CREATE TABLE "${config.schema}"."${config.name}" (${columns.join(',')})`;
}

beforeAll(async () => {
  client = new PGlite();
  await client.waitReady;
  await client.exec('CREATE SCHEMA auth; CREATE SCHEMA kernel; CREATE SCHEMA operator;');
  for (const table of tables) await client.exec(createTable(table));
  await client.exec(`
    CREATE UNIQUE INDEX uniq_vwe ON kernel.vault_owner_envelopes (field,key_id);
    CREATE UNIQUE INDEX uniq_provision ON kernel.internal_secret_provisions (owner_did,purpose);
    CREATE UNIQUE INDEX uniq_vault_delegation_active ON kernel.vault_delegation_grants (subject,granted_to,field,key_id) WHERE status='active';
  `);
  db = drizzle(client);
  h.db = db;
});
afterAll(async () => { await client.close(); });
beforeEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  h.log.mockClear(); h.emit.mockClear(); h.publish.mockClear();
  h.saveError = null;
  h.vault = { version: 1, entries: [] };
  h.identity = { id: HUMAN, scope: 'actor', subtype: 'human', actingAs: ORG };
  for (const table of tables) await db.delete(table);
  await db.insert(identities).values([
    { id: HUMAN, scope: 'actor', subtype: 'human', publicKey: personKeys.publicKey, tier: 'established', name: 'Human' },
    { id: AGENT, scope: 'actor', subtype: 'agent', publicKey: agentKeys.publicKey, tier: 'established', name: 'Agent' },
    { id: ORG, scope: 'business', subtype: 'organization', publicKey: generateKeypair().publicKey, tier: 'established', name: 'Organization' },
  ]);
  await db.insert(identityMembers).values({ identityDid: ORG, memberDid: HUMAN, role: 'admin' });
});

function request(body: unknown, url = 'https://kernel.test/api/vault/import') {
  return new NextRequest(url, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
}
async function propose(secret: string, extra: Record<string, unknown> = {}) {
  const response = await POST(request({ ownerDid: ORG, consumerDid: AGENT, purpose: 'provider-call', secret, ...extra }));
  expect(response.status).toBe(201);
  return await response.json() as { proposalId: string; fingerprint: string; purpose: string; status: string };
}
async function approve(proposalId: string) {
  const [row] = await db.select().from(operatorApprovals).where(eq(operatorApprovals.proposalId, proposalId));
  const decidedAt = new Date().toISOString();
  const sig = crypto.signSync(canonicalize({ contentHash: row.contentHash!, decision: 'approve', decidedAt }), personKeys.privateKey);
  const result = await decideOperatorApproval({
    proposalId, operatorDid: HUMAN, decision: 'approve', decidedAt,
    operatorSignature: { keyId: personKeys.publicKey, alg: 'ed25519', sig },
  });
  if (!result.ok) throw new Error(result.error);
  return result.card;
}
async function imported(secret: string, extra: Record<string, unknown> = {}) {
  const proposal = await propose(secret, extra);
  const card = await approve(proposal.proposalId);
  expect(await executeVaultApproval(card)).toEqual({ ok: true });
  const [grant] = await listGrantsForGrantee({ granteeDid: AGENT, purpose: 'provider-call' });
  return { proposal, card, grant };
}

describe('vault import acceptance — real SQL, signatures, encryption and grants', () => {
  it('can stage metadata-bound operator input with current organization authority', async () => {
    expect(await canExecuteImport(HUMAN, ORG)).toBe(true);
    const value = randomBytes(20).toString('hex');
    await stageImport('staging_probe', HUMAN, {
      ownerDid: ORG, consumerDid: AGENT, purpose: 'probe', fingerprint: importFingerprint(value),
      label: null, expiresAt: null, replacesField: null,
    }, value);
    await recordApprovalRequested({
      proposalId: 'proposal_probe', operatorDid: HUMAN, source: 'vault', kind: 'vault:import', summary: 'Import',
      keysTouched: [], detail: null, contentHash: null, notificationId: null, signerDid: HUMAN,
    });
  });
  it('stages without any grant, never persists plaintext outside encrypted vault bytes or returns/logs it', async () => {
    const secret = randomBytes(48).toString('base64');
    const result = await propose(secret, { label: 'Provider', expiresAt: new Date(Date.now() + 60_000).toISOString() });
    expect(Object.keys(result).sort()).toEqual(['fingerprint', 'proposalId', 'purpose', 'status']);
    expect(result.fingerprint).toBe(importFingerprint(secret));
    expect(await listGrantsForGrantee({ granteeDid: AGENT })).toEqual([]);
    const [row] = await db.select().from(operatorApprovals);
    expect(row.operatorDid).toBe(HUMAN); // never re-addressed to the node or the org
    expect(row.detail).toMatchObject({ ownerDid: ORG, consumerDid: AGENT, label: 'Provider', fingerprint: result.fingerprint });
    expect(JSON.stringify([result, row, h.vault, h.log.mock.calls, await db.select().from(internalSecretProvisions)])).not.toContain(secret);
    expect(h.vault.entries[0].version).toBe(1);
    expect(await GET(new NextRequest('https://kernel.test/api/vault/import')).then(r => r.json())).toMatchObject({
      ownerDid: ORG, owners: [{ did: HUMAN, name: 'Human' }, { did: ORG, name: 'Organization' }], cards: [],
    });
  });

  it('imports in an organization, discovers by purpose, fetches via current HTTP routes and boots with SDK deferred ack', async () => {
    const secret = randomBytes(48).toString('base64');
    const { grant } = await imported(secret);
    expect(grant).toMatchObject({ subject: ORG, purpose: 'provider-call', oneTime: false, status: 'active' });
    h.identity = { id: AGENT, scope: 'actor', subtype: 'agent' };
    const discovery = await listRoute(new Request('https://kernel.test/api/vault/delegation/grants?purpose=provider-call'));
    expect(await discovery.json()).toMatchObject({ grants: [{ grantId: grant.grantId, subject: ORG }] });
    const challenge = randomBytes(32).toString('hex');
    const token = randomBytes(32).toString('hex');
    const fetchStub = vi.fn(async (url: string, init?: RequestInit) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/api/challenge') return Response.json({ challengeId: 'test-challenge', challenge });
      if (parsed.pathname === '/api/authenticate') {
        const body = JSON.parse(init!.body as string);
        expect(crypto.verifySync(body.signature, challenge, agentKeys.publicKey)).toBe(true);
        return Response.json({ token });
      }
      const req = new NextRequest(url, init);
      if (parsed.pathname.endsWith('/fetch')) return fetchRoute(req, { params: Promise.resolve({ grantId: grant.grantId }) });
      if (parsed.pathname.endsWith('/ack')) return ackRoute(req, { params: Promise.resolve({ grantId: grant.grantId }) });
      return listRoute(req);
    });
    vi.stubGlobal('fetch', fetchStub);
    const boot = await loadFromVault({
      authServiceUrl: 'https://kernel.test', identity: { did: AGENT, privateKey: agentKeys.privateKey },
      purpose: 'provider-call', resolveGrantByPurpose: 'provider-call', keys: [{ key: 'provider', onMissing: 'fail' }],
    });
    expect(boot.values.provider).toBe(secret);
    expect((await listImportedKeyCards([ORG]))[0].timeline).toContainEqual(expect.objectContaining({ type: 'fetched', alert: true }));
    boot.acks.provider.used('provider-call');
    await vi.waitFor(async () => expect((await listImportedKeyCards([ORG]))[0].timeline.some(e => e.type === 'acked')).toBe(true));
    expect(await fetchGrantSecret({ grantId: grant.grantId, granteeDid: STRANGER })).toEqual({ status: 'not_grantee' });
    expect(JSON.stringify([h.vault, h.emit.mock.calls, h.publish.mock.calls, h.log.mock.calls])).not.toContain(secret);
    expect(h.emit).toHaveBeenCalledWith(expect.objectContaining({
      issuer_did: getNodeSigningIdentity().senderDid, subject_did: ORG, type: 'vault.key.imported',
      payload: expect.objectContaining({ fingerprint: importFingerprint(secret), ownerDid: ORG, authorizedBy: expect.objectContaining({ operatorDid: HUMAN }) }),
    }));
  });

  it.each(['member', 'maintainer', 'agent'])('rejects a current %s even with an admin act-as cookie', async role => {
    await db.update(identityMembers).set({ role });
    const response = await POST(request({ ownerDid: ORG, purpose: 'provider-call', consumerDid: AGENT, secret: randomBytes(20).toString('hex') }));
    expect(response.status).toBe(403);
    expect(await db.select().from(operatorApprovals)).toEqual([]);
  });

  it('excludes removed or service-restricted admins, and never returns another owner’s metadata', async () => {
    await db.update(identityMembers).set({ allowedServices: ['pay'] });
    expect(await listImportOwners(HUMAN)).toEqual([{ did: HUMAN, name: 'Human' }]);
    expect((await GET(new NextRequest(`https://kernel.test/api/vault/import?ownerDid=${ORG}`))).status).toBe(403);
    await db.update(identityMembers).set({ allowedServices: null, removedAt: new Date() });
    expect(await listImportOwners(HUMAN)).toHaveLength(1);
    expect(await listImportedKeyCards([STRANGER])).toEqual([]);
  });

  it('rejects unrelated coarse delegation on both GET metadata and POST staging', async () => {
    const original = await imported(randomBytes(20).toString('hex'));
    const existingVault = structuredClone(h.vault);
    const proposalsBefore = await db.select().from(operatorApprovals);
    // requireAuth has accepted this coarse X-Acting-For context, as it does
    // for any unrelated active capability. That is not vault authority.
    h.identity = { id: AGENT, scope: 'actor', subtype: 'agent', actingFor: HUMAN };
    const metadata = await GET(new NextRequest('https://kernel.test/api/vault/import'));
    expect(metadata.status).toBe(403);
    const response = await metadata.json();
    expect(response.code).toBe('AGENT_APPROVAL_REQUIRED');
    expect(response).not.toHaveProperty('owners');
    expect(response).not.toHaveProperty('cards');
    expect(JSON.stringify(response)).not.toContain(original.proposal.fingerprint);
    const secret = randomBytes(20).toString('hex');
    const staged = await POST(request({ ownerDid: ORG, purpose: 'provider-call', consumerDid: AGENT, secret }));
    expect(staged.status).toBe(403);
    expect(await staged.json()).toMatchObject({ code: 'AGENT_APPROVAL_REQUIRED' });
    expect(h.vault).toEqual(existingVault);
    expect(await db.select().from(operatorApprovals)).toEqual(proposalsBefore);
    expect(await db.select().from(internalSecretProvisions)).toEqual([]);
    expect(JSON.stringify(h.log.mock.calls)).not.toContain(secret);
  });

  it('rejects self-delegation overlays, standalone agents and arbitrary node ownership', async () => {
    h.identity = { id: HUMAN, scope: 'actor', subtype: 'human', actingFor: HUMAN };
    expect((await GET(new NextRequest('https://kernel.test/api/vault/import'))).status).toBe(403);
    expect((await POST(request({}))).status).toBe(403);
    h.identity = { id: AGENT, scope: 'actor', subtype: 'agent' };
    expect((await POST(request({}))).status).toBe(403);
    h.identity = { id: getNodeSigningIdentity().senderDid, scope: 'actor', subtype: 'agent' };
    expect((await POST(request({ ownerDid: STRANGER, consumerDid: AGENT, purpose: 'provider-call', secret: randomBytes(20).toString('hex') }))).status).toBe(403);
    expect(await canExecuteImport(AGENT, ORG)).toBe(false);
  });

  it('allows personal ownership and authorized direct-node ownership without arbitrary ownership grants', async () => {
    await imported(randomBytes(20).toString('hex'), { ownerDid: HUMAN });
    h.identity = { id: getNodeSigningIdentity().senderDid, scope: 'actor', subtype: 'agent' };
    await imported(randomBytes(20).toString('hex'), { ownerDid: h.identity.id });
  });

  it('rechecks current authority after proposal approval and refuses unsigned or rejected decisions', async () => {
    const proposal = await propose(randomBytes(20).toString('hex'));
    const card = await approve(proposal.proposalId);
    expect(await executeImportApproval({ ...card, decision: null })).toMatchObject({ ok: false });
    expect(await executeImportApproval({ ...card, status: 'denied' })).toMatchObject({ ok: false });
    await db.update(identityMembers).set({ removedAt: new Date() });
    expect(await executeImportApproval(card)).toMatchObject({ ok: false });
    expect(await listGrantsForGrantee({ granteeDid: AGENT })).toEqual([]);
  });

  it('binds owner, consumer, purpose, label, expiry and fingerprint to the staged bytes', async () => {
    const proposal = await propose(randomBytes(20).toString('hex'));
    const card = await approve(proposal.proposalId);
    for (const patch of [{ ownerDid: HUMAN }, { consumerDid: STRANGER }, { purpose: 'other' }, { label: 'other' }, { expiresAt: new Date(Date.now() + 60_000).toISOString() }, { fingerprint: 'a'.repeat(64) }]) {
      const altered = { ...card, detail: { ...card.detail, ...patch } };
      expect(await executeImportApproval(altered)).toMatchObject({ ok: false });
    }
    expect(await executeImportApproval(card)).toEqual({ ok: true });
    expect(await executeImportApproval(card)).toMatchObject({ ok: false }); // single use, even on executor retry
  });

  it('rotates as one signed transaction, new fetch succeeds and old grant is revoked and erased', async () => {
    const old = await imported(randomBytes(20).toString('hex'));
    const next = randomBytes(20).toString('hex');
    const rotated = await imported(next, { replacesField: old.grant.field });
    expect(rotated.grant.grantId).not.toBe(old.grant.grantId);
    expect(await fetchGrantSecret({ grantId: old.grant.grantId, granteeDid: AGENT })).toEqual({ status: 'inactive' });
    expect(await fetchGrantSecret({ grantId: rotated.grant.grantId, granteeDid: AGENT })).toMatchObject({ status: 'ok', value: next });
    const [oldRow] = await db.select().from(vaultDelegationGrants).where(eq(vaultDelegationGrants.id, old.grant.grantId));
    expect(oldRow.wrappedKey).toBe('');
  });

  it('preserves old value and grant if the new ciphertext cannot persist, and sanitizes provider errors', async () => {
    const oldValue = randomBytes(20).toString('hex');
    const old = await imported(oldValue);
    const newValue = randomBytes(20).toString('hex');
    const proposal = await propose(newValue, { replacesField: old.grant.field });
    const card = await approve(proposal.proposalId);
    const originalSet = vaultService.set.bind(vaultService);
    const setSpy = vi.spyOn(vaultService, 'set').mockImplementation(async entry => {
      if (entry.field === importedKeyField(proposal.proposalId)) throw new Error(newValue);
      return originalSet(entry);
    });
    expect(await executeImportApproval(card)).toMatchObject({ ok: false });
    expect(await fetchGrantSecret({ grantId: old.grant.grantId, granteeDid: AGENT })).toMatchObject({ status: 'ok', value: oldValue });
    expect((await listGrantsForGrantee({ granteeDid: AGENT })).filter(g => g.status === 'active')).toHaveLength(1);
    expect(JSON.stringify(h.log.mock.calls)).not.toContain(newValue);
    expect(h.vault.entries.some(entry => entry.field === importedKeyField(proposal.proposalId))).toBe(false);
    setSpy.mockRestore();
  });

  it('rejects cross-owner and changed-consumer rotation before staging a new credential', async () => {
    const old = await imported(randomBytes(20).toString('hex'));
    for (const extra of [{ ownerDid: HUMAN }, { consumerDid: STRANGER }, { purpose: 'other' }]) {
      const response = await POST(request({ ownerDid: ORG, consumerDid: AGENT, purpose: 'provider-call', secret: randomBytes(20).toString('hex'), replacesField: old.grant.field, ...extra }));
      expect(response.status).toBe(409);
    }
    expect((await listGrantsForGrantee({ granteeDid: AGENT })).filter(g => g.status === 'active')).toHaveLength(1);
  });

  it('denial erases staged material through the existing lifecycle cleanup', async () => {
    const proposal = await propose(randomBytes(20).toString('hex'));
    const result = await decideOperatorApproval({ proposalId: proposal.proposalId, operatorDid: HUMAN, decision: 'reject' });
    expect(result.ok).toBe(true);
    expect(h.vault.entries).toEqual([]);
    expect(await db.select().from(internalSecretProvisions)).toEqual([]);
  });

  it('validates bounded structured input without reflecting malformed bytes', async () => {
    for (const raw of [null, [], {}, { secret: randomBytes(20).toString('hex') }, { ownerDid: ORG, consumerDid: AGENT, purpose: 'p', secret: '', extra: true }]) {
      expect(validateImportBody(raw)).toBe(false);
      expect((await POST(request(raw))).status).toBe(400);
    }
    const value = randomBytes(20).toString('hex');
    expect(validateImportBody({ ownerDid: ORG, consumerDid: AGENT, purpose: 'p', secret: value })).toBe(true);
    const response = await POST(new NextRequest('https://kernel.test/api/vault/import', { method: 'POST', body: value }));
    expect(await response.text()).not.toContain(value);
  });
});
