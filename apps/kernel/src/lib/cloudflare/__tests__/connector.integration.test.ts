import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { NextRequest } from 'next/server';
import { canonicalize, crypto as authCrypto } from '@imajin/auth';
import * as authSchema from '@/src/db/schemas/auth';
import * as operatorSchema from '@/src/db/schemas/operator-approvals';
import * as vaultSchema from '@/src/db/schemas/vault';

const state = vi.hoisted(() => ({
  db: undefined as unknown, binding: vi.fn(), credential: vi.fn(), human: vi.fn(), controls: vi.fn(),
  session: vi.fn(), app: vi.fn(), stage: vi.fn(),
}));
vi.mock('@/src/db', async () => ({
  get db() { return state.db; }, ...await import('@/src/db/schemas/auth'),
  ...await import('@/src/db/schemas/operator-approvals'), ...await import('@/src/db/schemas/vault'),
}));
vi.mock('@/src/lib/domains/service', () => ({ resolveVerifiedDomain: state.binding }));
vi.mock('@/src/lib/vault', () => ({ fetchGrantSecret: state.credential }));
vi.mock('@/src/lib/vault/import-authority', () => ({ isImportHuman: state.human, controlsImportOwner: state.controls }));
vi.mock('@/src/lib/vault/sealing', () => ({ getNodeSigningIdentity: () => ({ senderDid: 'did:imajin:node' }) }));
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeDid: async () => 'did:imajin:node' }));
vi.mock('@/src/lib/auth/attest-delegation', () => ({ validateAttestDelegationCapabilities: vi.fn() }));
vi.mock('@/src/lib/notify/operator-approvals-service', () => ({
  recordApprovalRequested: async (input: Record<string, unknown>) => {
    state.stage(input);
    const database = state.db as ReturnType<typeof drizzle>;
    await database.insert(operatorSchema.operatorApprovals).values(input as typeof operatorSchema.operatorApprovals.$inferInsert);
  },
}));
vi.mock('@imajin/auth', async original => ({
  ...await original<typeof import('@imajin/auth')>(), requireAuth: state.session, requireAppAuth: state.app,
}));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
import { authenticateCloudflare, authorizeZone } from '../authority';
import { cloudflareRoute } from '../routes';
import { executeCloudflareApproval } from '../approvals';
import { computeApprovalContentHash } from '@/src/lib/notify/operator-approvals';
import type { OperatorApprovalCard } from '@/src/lib/notify/operator-approvals-service';
import { countersignedMessage } from '@/src/lib/notify/operator-countersign-fields';

const zoneId = 'a'.repeat(32);
const recordId = 'b'.repeat(32);
const hostnameId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ownerDid = 'did:imajin:G';
const actor = { did: 'did:imajin:A', humanSession: false };
const token = 'synthetic-key-never-return-this';
const nodeKeys = authCrypto.generateKeypair();
const humanKeys = authCrypto.generateKeypair();
const schema = { ...authSchema, ...operatorSchema, ...vaultSchema };
let pg: PGlite;
let proxied = false;
let ruleSet: unknown[] = [];
const record = () => ({ id: recordId, type: 'A', name: 'www.example.com', content: '192.0.2.1',
  ttl: 1, proxied, proxiable: true, metadata: { private: 'omit' } });
const response = (result: unknown) => new Response(JSON.stringify({ success: true, result }));

beforeAll(async () => {
  pg = new PGlite();
  state.db = drizzle(pg, { schema });
  await pg.exec('CREATE SCHEMA auth; CREATE SCHEMA kernel; CREATE SCHEMA operator;');
  await pg.exec(await readFile(new URL('../../../../../../migrations/0099_delegation_grants.sql', import.meta.url), 'utf8'));
  await pg.exec(`ALTER TABLE auth.delegation_grants ADD COLUMN last_used_at timestamptz;
    CREATE TABLE auth.identities (id text PRIMARY KEY, public_key text, scope text, tier text);
    CREATE TABLE kernel.vault_delegation_grants (
      id text PRIMARY KEY, subject text, granted_to text, purpose text, status text,
      expires_at timestamptz, one_time boolean, consumed_at timestamptz
    );
    CREATE TABLE auth.attestations (
      id text PRIMARY KEY, issuer_did text, subject_did text, type text,
      context_id text, context_type text, payload jsonb, signature text, cid text,
      attestation_status text, issued_at timestamptz,
      nostr_sig text, author_jws text, witness_jws text, document_hash text,
      document_asset_id text, total_signers integer, delegator_did text, disclosure_scope text,
      prev_event_ref text, delegation_grant_id text, supersedes text, ref text,
      expires_at timestamptz, revoked_at timestamptz, lapsed_at timestamptz
    );
    CREATE TABLE operator.approvals (
      proposal_id text PRIMARY KEY, operator_did text, source text, kind text, summary text,
      keys_touched jsonb, detail jsonb, content_hash text, notification_id text, signer_did text,
      status text DEFAULT 'pending', decision jsonb, outcome jsonb, applied_at timestamptz,
      created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
    );`);
}, 30_000);
afterAll(async () => { await pg.close(); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
beforeEach(async () => {
  vi.clearAllMocks();
  proxied = false;
  ruleSet = [];
  vi.stubEnv('AUTH_PRIVATE_KEY', nodeKeys.privateKey);
  await pg.exec(`TRUNCATE auth.delegation_grants CASCADE; TRUNCATE kernel.vault_delegation_grants, auth.attestations, operator.approvals;
    INSERT INTO auth.delegation_grants(id, agent_did, delegator_did, audience, expires_at)
      VALUES ('g', 'did:imajin:A', 'did:imajin:G', '{"type":"dids","values":["did:imajin:cloudflare-${zoneId}"]}', now() + interval '1 hour');
    INSERT INTO auth.delegation_grant_capabilities(id,grant_id,capability)
      VALUES ('r','g','cloudflare:read'),('d','g','cloudflare:dns'),('c','g','cloudflare:cache'),('h','g','cloudflare:custom-hostnames'),('s','g','cloudflare:ssl');
    INSERT INTO kernel.vault_delegation_grants VALUES
      ('sealed','did:imajin:G','did:imajin:node','dns.cloudflare:${zoneId}','active',NULL,false,NULL);`);
  await pg.query("INSERT INTO auth.identities VALUES ($1,$2,'actor','established') ON CONFLICT(id) DO UPDATE SET public_key=EXCLUDED.public_key",
    [actor.did, humanKeys.publicKey]);
  state.binding.mockResolvedValue({ domain: 'example.com', zoneOwner: ownerDid, siteOwner: 'did:imajin:site' });
  state.credential.mockResolvedValue({ status: 'ok', value: token,
    grant: { subject: ownerDid, grantedTo: 'did:imajin:node', purpose: `dns.cloudflare:${zoneId}` } });
  state.human.mockImplementation(async did => did === 'did:imajin:human');
  state.controls.mockImplementation(async did => did === 'did:imajin:human');
  state.session.mockResolvedValue({ identity: { id: actor.did, scope: 'actor', subtype: 'agent' } });
  state.app.mockResolvedValue({ error: 'not token', status: 401, notAppToken: true });
  vi.stubGlobal('fetch', vi.fn(providerFetch));
});

async function providerFetch(input: string, init?: RequestInit): Promise<Response> {
    const url = new URL(input);
    const path = url.pathname.split(`/zones/${zoneId}`)[1];
    if (path === '') return response({ id: zoneId, name: 'example.com' });
    if (path === '/dns_records' && init?.method === 'GET') return response([record()]);
    if (path === '/dns_records' && init?.method === 'POST') return response({ ...record(), ...JSON.parse(init.body as string) });
    if (path === `/dns_records/${recordId}` && init?.method === 'PATCH') {
      proxied = JSON.parse(init.body as string).proxied ?? proxied;
      return response(record());
    }
    if (init?.method === 'DELETE') return response({ id: path.includes('custom') ? hostnameId : recordId });
    if (path === `/dns_records/${recordId}`) return response(record());
    if (path === '/settings') return response([{ id: 'ssl', value: 'strict' }, { id: 'not-allowed', value: 'omit' }]);
    if (path === '/rulesets/phases/http_request_cache_settings/entrypoint') return cacheResponse(init);
    const host = { id: hostnameId, hostname: 'customer.example.net', status: 'active', ssl: { status: 'active' } };
    return response(path === '/custom_hostnames' && init?.method === 'GET' ? [host] : host);
}

function cacheResponse(init?: RequestInit): Response {
  if (init?.method === 'PUT') ruleSet = JSON.parse(init.body as string).rules;
  return response({ rules: ruleSet });
}

async function invoke(action: Parameters<typeof cloudflareRoute>[0], method = 'GET', body?: unknown, domain = 'example.com') {
  return cloudflareRoute(action)(new NextRequest(`http://localhost/cloudflare/api/zones/${zoneId}?domain=${domain}`, {
    method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
  }), { params: Promise.resolve({ zoneId, recordId, hostnameId }) });
}

async function approvedCard(): Promise<OperatorApprovalCard> {
  const proposal = state.stage.mock.calls.at(-1)![0];
  const contentHash = computeApprovalContentHash({
    proposalId: proposal.proposalId, source: proposal.source, kind: proposal.kind,
    summary: proposal.summary, keysTouched: proposal.keysTouched, detail: proposal.detail,
  });
  const decidedAt = new Date().toISOString();
  const card = {
    ...proposal, contentHash, status: 'approved', outcome: null, appliedAt: null, archivedAt: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    decision: { proposalId: proposal.proposalId, source: 'cloudflare', kind: proposal.kind,
      decision: 'approve', decidedBy: proposal.operatorDid, decidedAt,
      contentHash: `sha256:${contentHash}`, operatorSignature: { keyId: humanKeys.publicKey, alg: 'ed25519',
        sig: authCrypto.signSync(countersignedMessage({ contentHash, decision: 'approve', decidedAt }), humanKeys.privateKey) } },
  } as OperatorApprovalCard;
  await pg.query("UPDATE operator.approvals SET status='approved',decision=$1 WHERE proposal_id=$2",
    [{ payload: card.decision }, proposal.proposalId]);
  return card;
}

describe('G owns zone Z and grants A scoped Cloudflare authority', () => {
  it('uses real introspectGrant, existing purpose credential fetch and node-only consumer', async () => {
    const authorized = await authorizeZone(actor, zoneId, 'example.com', 'cloudflare:dns');
    expect(authorized.ownerDid).toBe(ownerDid);
    expect(state.credential).toHaveBeenCalledWith({ grantId: 'sealed', granteeDid: 'did:imajin:node', kernelCredentialUse: true });
    await expect(authorizeZone(actor, 'd'.repeat(32), 'example.com', 'cloudflare:dns')).rejects.toMatchObject({ status: 403 });
    await pg.exec("UPDATE auth.delegation_grants SET status='revoked'");
    await expect(authorizeZone(actor, zoneId, 'example.com', 'cloudflare:dns')).rejects.toMatchObject({ status: 403 });
  });

  it.each(['cloudflare:read', 'cloudflare:dns', 'cloudflare:cache', 'cloudflare:ssl', 'cloudflare:custom-hostnames'])('checks %s independently on every invocation', async capability => {
    await expect(authorizeZone(actor, zoneId, 'example.com', capability)).resolves.toMatchObject({ ownerDid });
    await pg.query('UPDATE auth.delegation_grant_capabilities SET status=$1 WHERE capability=$2', ['revoked', capability]);
    await expect(authorizeZone(actor, zoneId, 'example.com', capability)).rejects.toMatchObject({ status: 403 });
  });

  it('does not accept all-audience grants, absent keys, noncanonical or unverified domains', async () => {
    await pg.exec(`UPDATE auth.delegation_grants SET audience='{"type":"all"}'`);
    await expect(authorizeZone(actor, zoneId, 'example.com', 'cloudflare:dns')).rejects.toMatchObject({ status: 403 });
    await pg.query('UPDATE auth.delegation_grants SET audience=$1', [{ type: 'dids', values: [`did:imajin:cloudflare-${zoneId}`] }]);
    await pg.exec("UPDATE kernel.vault_delegation_grants SET status='revoked'");
    await expect(authorizeZone(actor, zoneId, 'example.com', 'cloudflare:dns')).rejects.toMatchObject({ status: 409 });
    await expect(authorizeZone(actor, zoneId, 'Example.com', 'cloudflare:dns')).rejects.toMatchObject({ status: 400 });
    state.binding.mockResolvedValue(null);
    await expect(authorizeZone(actor, zoneId, 'example.com', 'cloudflare:dns')).rejects.toMatchObject({ status: 403 });
  });

  it('uses actual session/app identities, not acting-as or acting-for overlays', async () => {
    state.session.mockResolvedValue({ identity: { id: actor.did, actingAs: ownerDid, actingFor: ownerDid } });
    expect(await authenticateCloudflare(new NextRequest('http://localhost'), 'cloudflare:dns')).toEqual(actor);
    state.app.mockResolvedValue({ appAuth: { userDid: actor.did, appDid: 'did:imajin:app', actingAs: ownerDid } });
    expect(await authenticateCloudflare(new NextRequest('http://localhost', { headers: { authorization: 'Bearer synthetic' } }), 'cloudflare:dns')).toEqual({ did: 'did:imajin:app', humanSession: false });
    state.app.mockResolvedValue({ appAuth: { userDid: '', appDid: 'did:imajin:app', isServiceToken: true } });
    expect(await authenticateCloudflare(new NextRequest('http://localhost', { headers: { authorization: 'Bearer synthetic' } }), 'cloudflare:dns'))
      .toEqual({ did: 'did:imajin:app', humanSession: false });
  });

  it('lists, creates, updates and deletes DNS, signing intent before mutation and signed outcomes', async () => {
    expect(await (await invoke('listDns')).json()).toMatchObject({ records: [{ id: recordId }] });
    expect((await invoke('createDns', 'POST', { domain: 'example.com', type: 'A', name: 'www.example.com', content: '192.0.2.1', ttl: 1 })).status).toBe(201);
    expect((await invoke('patchDns', 'PATCH', { proxied: true })).status).toBe(200);
    expect((await invoke('deleteDns', 'DELETE')).status).toBe(200);
    const result = await invoke('history');
    const data = await result.json();
    expect(data.history).toHaveLength(6);
    expect(JSON.stringify(data)).not.toContain(token);
    for (const row of data.history) {
      expect(row.payload).toMatchObject({ actorDid: actor.did, onBehalfOf: ownerDid, zoneId });
      expect(authCrypto.verifySync(row.signature, canonicalize({
        subject_did: row.subjectDid, type: row.type, context_id: row.contextId, context_type: row.contextType,
        payload: row.payload, issued_at: Date.parse(row.issuedAt),
      }), nodeKeys.publicKey)).toBe(true);
    }
  });

  it('refuses out-of-zone DNS and unknown write fields without an edge mutation', async () => {
    expect((await invoke('createDns', 'POST', { type: 'A', name: 'www.evil.test', content: '192.0.2.1', ttl: 1 })).status).toBe(403);
    expect((await invoke('patchDns', 'PATCH', { proxied: true, token: 'not-allowed' })).status).toBe(400);
    expect(vi.mocked(fetch).mock.calls.some(call => call[1]?.method === 'PATCH')).toBe(false);
  });

  it('bounds incoming bodies and rejects malformed or mismatched domain input', async () => {
    expect((await invoke('patchDns', 'PATCH', { content: 'x'.repeat(33_000) })).status).toBe(413);
    expect((await invoke('patchDns', 'PATCH', { domain: 'other.example', proxied: true })).status).toBe(403);
    const malformed = new NextRequest('http://localhost?domain=example.com', { method: 'PATCH', body: 'not-json' });
    expect((await cloudflareRoute('patchDns')(malformed, { params: Promise.resolve({ zoneId, recordId }) })).status).toBe(400);
  });

  it('serves settings/SSL, cache rules, and all custom-hostname operations with projected output', async () => {
    expect(await (await invoke('settings')).json()).toEqual({ settings: [{ id: 'ssl', value: 'strict' }] });
    expect(await (await invoke('ssl')).json()).toEqual({ ssl: { id: 'ssl', value: 'strict' } });
    expect(await (await invoke('cacheRules')).json()).toEqual({ rules: [] });
    expect((await invoke('createHostname', 'POST', { hostname: 'customer.example.net', ssl: { method: 'http', type: 'dv' } })).status).toBe(201);
    expect(await (await invoke('listHostnames')).json()).toMatchObject({ hostnames: [{ id: hostnameId }] });
    expect(await (await invoke('hostname')).json()).toMatchObject({ hostname: { id: hostnameId } });
    expect((await invoke('deleteHostname', 'DELETE')).status).toBe(200);
  });

  it('fails closed before the mutation when audit persistence is unavailable', async () => {
    await pg.exec('ALTER TABLE auth.attestations RENAME TO unavailable_attestations');
    try {
      expect((await invoke('patchDns', 'PATCH', { proxied: true })).status).toBe(503);
      expect(vi.mocked(fetch).mock.calls.some(call => call[1]?.method === 'PATCH')).toBe(false);
    } finally { await pg.exec('ALTER TABLE auth.unavailable_attestations RENAME TO attestations'); }
  });

  it('dry-runs bulk, stages approval, refuses unsigned, applies once and rejects replay', async () => {
    const body = { domain: 'example.com', changes: [{ recordId, proxied: true }], dryRun: true };
    expect(await (await invoke('bulk', 'POST', body)).json()).toMatchObject({ dryRun: true, changes: [{ before: { proxied: false }, after: { proxied: true } }] });
    expect(state.stage).not.toHaveBeenCalled();
    // A real current owner/admin is selected as the approver; this is not grantee authority.
    state.human.mockImplementation(async did => did === 'did:imajin:human' || did === actor.did);
    state.controls.mockImplementation(async did => did === 'did:imajin:human' || did === actor.did);
    expect((await invoke('bulk', 'POST', { ...body, dryRun: false })).status).toBe(202);
    const card = await approvedCard();
    expect(await executeCloudflareApproval({ ...card, decision: { ...card.decision!, operatorSignature: undefined } })).toMatchObject({ ok: false });
    expect(await executeCloudflareApproval(card)).toEqual({ ok: true });
    expect(proxied).toBe(true);
    expect(await executeCloudflareApproval(card)).toMatchObject({ ok: false });
    expect(vi.mocked(fetch).mock.calls.filter(call => call[1]?.method === 'PATCH')).toHaveLength(1);
  });

  it('rejects stale and revoked bulk plans without applying, and consumes failed claims', async () => {
    state.human.mockResolvedValue(true);
    state.controls.mockResolvedValue(true);
    await invoke('bulk', 'POST', { changes: [{ recordId, proxied: true }], dryRun: false });
    const card = await approvedCard();
    proxied = true;
    expect(await executeCloudflareApproval(card)).toMatchObject({ ok: false });
    proxied = false;
    expect(await executeCloudflareApproval(card)).toMatchObject({ ok: false });
    expect(vi.mocked(fetch).mock.calls.some(call => call[1]?.method === 'PATCH')).toBe(false);
  });
  it('cache replacement uses the same dry-run and approval-only mutation rail', async () => {
    state.human.mockResolvedValue(true);
    state.controls.mockResolvedValue(true);
    const rules = [{ action: 'set_cache_settings', expression: 'true', enabled: true, action_parameters: { cache: true } }];
    expect((await invoke('setCache', 'PUT', { rules, dryRun: true })).status).toBe(200);
    expect(ruleSet).toEqual([]);
    expect((await invoke('setCache', 'PUT', { rules, dryRun: false })).status).toBe(202);
    const card = await approvedCard();
    expect(await executeCloudflareApproval(card)).toEqual({ ok: true });
    expect(ruleSet).toEqual(rules);
  });

  it('verifies actual human countersignatures and durable decision binding', async () => {
    state.human.mockResolvedValue(true);
    state.controls.mockResolvedValue(true);
    await invoke('bulk', 'POST', { changes: [{ recordId, proxied: true }], dryRun: false });
    const card = await approvedCard();
    const invalid = { ...card, decision: { ...card.decision!, operatorSignature: {
      ...card.decision!.operatorSignature!, sig: '0'.repeat(128),
    } } };
    expect(await executeCloudflareApproval(invalid)).toMatchObject({ ok: false });
    await pg.query("UPDATE operator.approvals SET decision='{}' WHERE proposal_id=$1", [card.proposalId]);
    expect(await executeCloudflareApproval(card)).toMatchObject({ ok: false });
    expect(vi.mocked(fetch).mock.calls.some(call => call[1]?.method === 'PATCH')).toBe(false);
  });

  it('reauthorizes after approval and never retries a claimed partial failure', async () => {
    state.human.mockResolvedValue(true);
    state.controls.mockResolvedValue(true);
    const secondId = 'd'.repeat(32);
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url).endsWith(`/dns_records/${secondId}`)) {
        if (init?.method === 'PATCH') return new Response(JSON.stringify({ error: token }), { status: 500 });
        return response({ ...record(), id: secondId, name: 'second.example.com', proxied: false });
      }
      return original(url, init);
    });
    await invoke('bulk', 'POST', { changes: [{ recordId, proxied: true }, { recordId: secondId, proxied: true }], dryRun: false });
    const card = await approvedCard();
    expect(await executeCloudflareApproval(card)).toMatchObject({ ok: false });
    expect(proxied).toBe(true);
    expect(vi.mocked(fetch).mock.calls.filter(call => call[1]?.method === 'PATCH')).toHaveLength(2);
    vi.mocked(fetch).mockImplementation(original);
    expect(await executeCloudflareApproval(card)).toMatchObject({ ok: false });
    expect(vi.mocked(fetch).mock.calls.filter(call => call[1]?.method === 'PATCH')).toHaveLength(2);
    const history = await (await invoke('history')).json();
    expect(history.history.some((row: { payload: { phase: string } }) => row.payload.phase === 'failure')).toBe(true);
    expect(JSON.stringify(history)).not.toContain(token);
  });

  it('denies a freshly revoked delegate at approval apply time', async () => {
    // The approver is human A, but the staged actor is an app token: owner
    // membership is not delegated authority and cannot bypass introspection.
    state.app.mockResolvedValue({ appAuth: { userDid: ownerDid, appDid: actor.did } });
    state.human.mockResolvedValue(true);
    state.controls.mockResolvedValue(true);
    const request = new NextRequest(`http://localhost?domain=example.com`, { method: 'POST',
      headers: { authorization: 'Bearer synthetic' }, body: JSON.stringify({ changes: [{ recordId, proxied: true }], dryRun: false }) });
    expect((await cloudflareRoute('bulk')(request, { params: Promise.resolve({ zoneId }) })).status).toBe(202);
    const card = await approvedCard();
    await pg.exec("UPDATE auth.delegation_grants SET status='revoked'");
    expect(await executeCloudflareApproval(card)).toMatchObject({ ok: false });
    expect(vi.mocked(fetch).mock.calls.some(call => call[1]?.method === 'PATCH')).toBe(false);
  });
});
