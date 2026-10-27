import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { VaultFile } from '@imajin/vault-core';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const h = vi.hoisted(() => ({
  db: null as unknown, nodeDid: '', seeds: [] as string[],
  auth: {} as Record<string, unknown>, log: vi.fn(), publish: vi.fn().mockResolvedValue(undefined),
  vault: { version: 1, entries: [] } as VaultFile,
  saveError: false,
}));
vi.mock('@/src/db', async () => {
  const auth = await import('@/src/db/schemas/auth');
  const vault = await import('@/src/db/schemas/vault');
  const { forwardingDb } = await import('@/src/lib/notify/__tests__/pglite-connector-inbox-harness');
  return { ...auth, ...vault, db: forwardingDb(() => h.db) };
});

vi.mock('@imajin/auth', async original => {
  const actual = await original<typeof import('@imajin/auth')>();
  return {
    ...actual, requireAuth: vi.fn(async () => h.auth), requireAdmin: vi.fn(async () => true),
    generateKeypair: () => {
      const keys = actual.generateKeypair();
      h.seeds.push(keys.privateKey);
      return keys;
    },
  };
});
vi.mock('@imajin/bus', () => ({ publish: h.publish }));
vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ debug: h.log, info: h.log, warn: h.log, error: h.log }),
}));
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeDid: async () => h.nodeDid }));
vi.mock('../vault-repository', () => ({
  getVaultRepository: () => ({
    load: async () => structuredClone(h.vault),
    save: async (vault: VaultFile) => {
      if (h.saveError) throw new Error(h.seeds.at(-1));
      h.vault = structuredClone(vault);
    },
  }),
}));

import { canonicalize, crypto, generateKeypair } from '@imajin/auth';
import { attestations } from '@/src/db/schemas/auth';
import { vaultMintedKeys, vaultDelegationGrants, vaultOwnerEnvelopes, vaultGrantRequests } from '@/src/db/schemas/vault';
import { getNodeSigningIdentity, _resetSealingCache } from '../sealing';
import { mintSshCa, revokeSshCa, trustedSshCaKeys, sshCaPublicKey } from '../ssh-ca';
import { SSH_CA_MAX_CERT_TTL_SECONDS } from '../ssh-ca-policy';
import { grantExistingMintedKey } from '../grant';
import { revokeMintedKey, mintedKeyField } from '../mint';
import { fetchGrantSecret, loadAndUnseal, loadAndUnsealByGrantee, listRenewableGrants } from '../index';
import { getMintedKeyByDid, listVaultKeyCards, listHandProvisionedFields } from '../key-cards';
import { POST as mintRoute } from '@/app/api/vault/ssh-ca/route';
import { POST as rotateRoute } from '@/app/api/vault/ssh-ca/rotate/route';
import { POST as revokeRoute } from '@/app/api/vault/ssh-ca/revoke/route';
import { GET as trustedRoute } from '@/app/api/vault/ssh-ca/trusted-keys/route';
import { GET as listRoute } from '@/app/api/vault/list/route';
import { POST as signRoute } from '@/app/api/vault/ssh-ca/sign/route';
import { POST as grantRoute } from '@/app/api/vault/ssh-ca/grants/route';
import { POST as withdrawRoute } from '@/app/api/vault/ssh-ca/grants/revoke/route';
import { canonicalizeGrantPayload } from '../index';
import { inspectCertificate, acceptsCertificate, openSshAccepts, openSshPublicKeyFingerprint } from './ssh-cert-inspect';
import * as mechanicalAudit from '@/src/lib/auth/emit-mechanical-attestation';
import { SSH_CERT_ISSUANCE_LIMIT, SSH_CERT_ISSUANCE_WINDOW_SECONDS } from '../ssh-ca-policy';
import * as githubOidc from '../github-oidc';
import { oidcFixture } from './github-oidc-fixture';

const nodeKeys = generateKeypair();
const tables = [attestations, vaultMintedKeys, vaultDelegationGrants, vaultOwnerEnvelopes, vaultGrantRequests];
let client: PGlite;
let database: ReturnType<typeof drizzle>;
let purpose: string;
let caseNumber = 0;
let responses: unknown[];
const authority = () => ({ actingDid: h.nodeDid, composedBy: 'did:imajin:operator-delegate' });

function createTable(table: PgTable) {
  const config = getTableConfig(table);
  const columns = config.columns.map(column => {
    let defaultSql = '';
    if (['created_at', 'updated_at', 'issued_at'].includes(column.name)) defaultSql = ' DEFAULT now()';
    else if (typeof column.default === 'string') defaultSql = ` DEFAULT '${column.default}'`;
    else if (typeof column.default === 'boolean') defaultSql = ` DEFAULT ${column.default}`;
    return `"${column.name}" ${column.getSQLType()}${column.primary ? ' PRIMARY KEY' : ''}${column.notNull ? ' NOT NULL' : ''}${defaultSql}`;
  });
  return `CREATE TABLE "${config.schema}"."${config.name}" (${columns.join(',')})`;
}

beforeAll(async () => {
  client = new PGlite();
  await client.waitReady;
  await client.exec('CREATE SCHEMA auth; CREATE SCHEMA kernel;');
  for (const table of tables) await client.exec(createTable(table));
  const migration = readFileSync('migrations/0221_vault_ssh_scope.sql', 'utf8');
  await client.exec(migration);
  await client.exec(migration); // Idempotent on an already-upgraded schema.
  const replayMigration = readFileSync('migrations/0222_vault_ssh_oidc_replay.sql', 'utf8');
  await client.exec(replayMigration);
  await client.exec(replayMigration);
  await client.exec(`
    CREATE UNIQUE INDEX uniq_minted_did ON kernel.vault_minted_keys(did);
    CREATE UNIQUE INDEX uniq_owner_envelope ON kernel.vault_owner_envelopes(field,key_id);
    CREATE UNIQUE INDEX uniq_active_grant ON kernel.vault_delegation_grants(subject,granted_to,field,key_id) WHERE status='active';
  `);
  database = drizzle(client);
  h.db = database;
});
afterAll(async () => { await client.close(); });
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('AUTH_PRIVATE_KEY', nodeKeys.privateKey);
  vi.stubEnv('VAULT_OWNER_X_PUB', '');
  vi.stubEnv('VAULT_OWNER_ED_PUB', '');
  _resetSealingCache();
  h.nodeDid = getNodeSigningIdentity().senderDid;
  h.auth = { identity: { id: h.nodeDid } };
  h.seeds = [];
  h.saveError = false;
  purpose = `deploy-${++caseNumber}`;
  responses = [];
});
afterEach(async () => {
  vi.useRealTimers();
  const persisted = await Promise.all(tables.map(table => database.select().from(table)));
  const visible = JSON.stringify([responses, persisted, h.vault, h.log.mock.calls, h.publish.mock.calls]);
  // Constant assertion output cannot reveal a private key on failure.
  expect(h.seeds.some(seed => visible.includes(seed)), 'Private CA material escaped custody').toBe(false);
  vi.unstubAllEnvs();
  _resetSealingCache();
});
const rows = () => database.select().from(vaultMintedKeys).where(eq(vaultMintedKeys.purpose, `ssh-ca:${purpose}`));
const audits = async () => (await database.select().from(attestations))
  .filter(row => row.payload?.purpose === purpose);
function request(body: unknown) {
  return new Request('https://kernel.test/api/vault/ssh-ca', { method: 'POST', body: JSON.stringify(body) });
}
async function trusted() {
  const response = await trustedRoute(new Request(`https://kernel.test/api/vault/ssh-ca/trusted-keys?purpose=${purpose}`));
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('content-type')).toContain('text/plain');
  const text = await response.text();
  responses.push(text);
  return text;
}
async function mint(rotate = false) {
  const result = await mintSshCa(purpose, authority(), rotate);
  responses.push(result);
  return result;
}

describe('SSH CA custody and lifecycle (#3063)', () => {
  it('mints using vault.mint and serves a real OpenSSH line with matching fingerprint', async () => {
    const response = await mintRoute(request({ purpose }));
    expect(response.status).toBe(201);
    const body = await response.json();
    responses.push(body);
    expect(Object.keys(body).sort()).toEqual(['caId', 'fingerprint', 'publicKey', 'purpose', 'status']);
    const [record] = await rows();
    expect(record.field).toContain('vault-ssh-ca:');
    expect(record.field).not.toBe(mintedKeyField(record.did));
    const [grant] = await database.select().from(vaultDelegationGrants).where(eq(vaultDelegationGrants.id, record.grantId!));
    expect(grant).toMatchObject({ grantedTo: h.nodeDid, oneTime: false, status: 'active' });
    h.auth = { error: 'Not authenticated', status: 401 }; // public trust does not need a credential
    const text = await trusted();
    expect(text).toBe(`${body.publicKey}\n`);
    // Independently parse RFC 8709; certificate tests also use CI's installed OpenSSH tools.
    const wire = Buffer.from(text.split(' ')[1], 'base64');
    expect(wire.readUInt32BE(0)).toBe(11);
    expect(wire.subarray(4, 15).toString()).toBe('ssh-ed25519');
    expect(wire.readUInt32BE(15)).toBe(32);
    expect(wire.subarray(19).toString('hex')).toBe(record.publicKey);
    expect(wire).toHaveLength(51);
    expect(body.fingerprint).toBe(`SHA256:${createHash('sha256').update(wire).digest('base64url').replaceAll('-', '+').replaceAll('_', '/')}`);
  });

  it('overlaps until exactly max TTL, then retires once without deleting history', async () => {
    const first = await mint();
    const second = await mint(true);
    expect((await trusted()).trim().split('\n')).toHaveLength(2);
    const [old] = (await rows()).filter(row => row.id === first.caId);
    expect(old.status).toBe('retiring');
    const [grant] = await database.select().from(vaultDelegationGrants).where(eq(vaultDelegationGrants.id, old.grantId!));
    expect(grant.status).toBe('revoked');
    expect(grant.wrappedKey.length === 0, 'Revoked wrapping material must be erased').toBe(true);
    const deadline = old.revokedAt!.getTime() + SSH_CA_MAX_CERT_TTL_SECONDS * 1000;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(deadline - 1);
    expect((await trusted()).trim().split('\n')).toHaveLength(2);
    vi.setSystemTime(deadline);
    // Fresh reads consult persistent state, not a timer or cached trust list.
    expect(await trusted()).toBe(`${second.publicKey}\n`);
    expect(await trusted()).toBe(`${second.publicKey}\n`);
    expect((await rows()).find(row => row.id === first.caId)?.status).toBe('retiring');
    expect((await audits()).filter(row => row.type === 'vault.ssh-ca.retired')).toHaveLength(0);
    await revokeSshCa(purpose, second.caId, authority()); // mutations reconcile retirement
    expect((await rows()).find(row => row.id === first.caId)?.status).toBe('retired');
    expect(await rows()).toHaveLength(2);
    expect((await audits()).filter(row => row.type === 'vault.ssh-ca.retired')).toHaveLength(1);
  });

  it.each([false, true])('emergency revoke immediately removes a key (overlapping=%s)', async overlap => {
    const first = await mint();
    if (overlap) await mint(true);
    responses.push(await revokeSshCa(purpose, first.caId, authority()));
    expect(await trusted()).not.toContain(first.publicKey);
    const [row] = (await rows()).filter(record => record.id === first.caId);
    expect(row.status).toBe('revoked');
    responses.push(await revokeSshCa(purpose, first.caId, authority()));
    expect((await audits()).filter(audit => audit.type === 'vault.ssh-ca.revoked')).toHaveLength(1);
    expect(await rows()).toHaveLength(overlap ? 2 : 1);
  });

  it('keeps independent retirement deadlines through rapid rotations and isolates purposes', async () => {
    const first = await mint();
    await mintSshCa(`${purpose}-other`, authority());
    const second = await mint(true);
    const [old] = (await rows()).filter(row => row.id === first.caId);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(old.revokedAt!.getTime() + 60_000);
    const third = await mint(true);
    vi.setSystemTime(old.revokedAt!.getTime() + SSH_CA_MAX_CERT_TTL_SECONDS * 1000);
    const trust = await trusted();
    expect(trust).not.toContain(first.publicKey);
    expect(trust).toContain(second.publicKey);
    expect(trust).toContain(third.publicKey);
    expect(trust.trim().split('\n')).toHaveLength(2);
    expect(await trustedSshCaKeys(`${purpose}-unknown`)).toBe('');
    await expect(revokeSshCa(`${purpose}-other`, first.caId, authority())).rejects.toMatchObject({ status: 404 });
  });

  it('writes verifiable signed events for mint, rotate, revoke and retire with actor and fingerprint', async () => {
    const first = await mint();
    const second = await mint(true);
    responses.push(await revokeSshCa(purpose, second.caId, authority()));
    const [old] = (await rows()).filter(row => row.id === first.caId);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(old.revokedAt!.getTime() + SSH_CA_MAX_CERT_TTL_SECONDS * 1000);
    expect(await trusted()).toBe('');
    await revokeSshCa(purpose, second.caId, authority());
    const events = await audits();
    expect(new Set(events.map(row => row.type))).toEqual(new Set([
      'vault.ssh-ca.minted', 'vault.ssh-ca.rotated', 'vault.ssh-ca.revoked', 'vault.ssh-ca.retired',
    ]));
    for (const event of events) {
      expect(event.payload).toMatchObject({ caId: expect.any(String), purpose, actor: h.nodeDid, fingerprint: expect.stringMatching(/^SHA256:/) });
      expect(event.issuerDid).toBe(h.nodeDid);
      expect(event.attestationStatus).toBeNull();
      expect(crypto.verifySync(event.signature, canonicalize({
        subject_did: event.subjectDid, type: event.type, context_id: event.contextId,
        context_type: event.contextType, payload: event.payload, issued_at: event.issuedAt.getTime(),
      }), nodeKeys.publicKey)).toBe(true);

    }
    expect(events.find(event => event.type === 'vault.ssh-ca.rotated')?.payload).toMatchObject({
      previousCaId: first.caId, caId: second.caId, composedBy: authority().composedBy,
    });
  });

  it('fails closed on all generic plaintext/grant/revoke paths, even for the node', async () => {
    const result = await mint();
    const [row] = await rows();
    for (const kernelCredentialUse of [false, true]) {
      expect(await fetchGrantSecret({ grantId: row.grantId!, granteeDid: h.nodeDid, kernelCredentialUse }))
        .toEqual({ status: 'not_grantee' });
    }
    await expect(loadAndUnseal(row.field)).rejects.toThrow();
    await expect(loadAndUnsealByGrantee(row.field, h.nodeDid)).rejects.toThrow();
    expect(await grantExistingMintedKey({ did: row.did, grantedTo: h.nodeDid, grantedBy: h.nodeDid }))
      .toEqual({ status: 'not_found' });
    expect(await revokeMintedKey({ did: row.did, revokedBy: h.nodeDid })).toEqual({ status: 'not_found' });
    expect(await getMintedKeyByDid(row.did)).toBeUndefined();
    expect((await listVaultKeyCards()).some(card => card.did === row.did)).toBe(false);
    expect((await listHandProvisionedFields()).some(entry => entry.field === row.field)).toBe(false);
    const listing = await listRoute();
    const listBody = await listing.json();
    responses.push(listBody);
    expect(listing.status).toBe(200);
    expect(JSON.stringify(listBody)).not.toContain(row.field);
    await mint(true);
    expect((await listRenewableGrants({ nodeDid: h.nodeDid })).some(grant => grant.field === row.field)).toBe(false);
    expect(await trusted()).toContain(result.publicKey);
  });

  it('refuses duplicate mint, missing rotation and invalid purpose before generation', async () => {
    await expect(mint(true)).rejects.toMatchObject({ status: 404 });
    await expect(mintSshCa('Bad purpose', authority())).rejects.toMatchObject({ status: 400 });
    expect(h.seeds).toHaveLength(0);
    await mint();
    await expect(mint()).rejects.toMatchObject({ status: 409 });
    expect(h.seeds).toHaveLength(1);
  });

  it('serializes concurrent mints to one signer and one signed mint event', async () => {
    const attempts = await Promise.allSettled([mint(), mint()]);
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(await rows()).toHaveLength(1);
    expect((await audits()).filter(row => row.type === 'vault.ssh-ca.minted')).toHaveLength(1);
    expect(h.seeds).toHaveLength(1);
  });

  it('serves lock-free public trust without signing credentials or retirement writes', async () => {
    const first = await mint();
    await mint(true);
    const [old] = (await rows()).filter(row => row.id === first.caId);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(old.revokedAt!.getTime() + SSH_CA_MAX_CERT_TTL_SECONDS * 1000);
    vi.stubEnv('AUTH_PRIVATE_KEY', '');
    const response = await trustedRoute(new Request(`https://kernel.test/trusted-keys?purpose=${purpose}`));
    responses.push(await response.text());
    expect(response.status).toBe(200);
    expect(responses.at(-1)).not.toContain(first.publicKey);
    expect((await rows()).find(row => row.id === first.caId)?.status).toBe('retiring');
    vi.stubEnv('AUTH_PRIVATE_KEY', nodeKeys.privateKey);
    expect(await trusted()).not.toContain(first.publicKey);
  });

  it('public trust reads do not enter a transaction or execute an advisory lock', async () => {
    await mint();
    const transaction = vi.spyOn(database, 'transaction');
    const execute = vi.spyOn(database, 'execute');
    try {
      expect(await trusted()).toContain('ssh-ed25519');
      expect(transaction).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    } finally { transaction.mockRestore(); execute.mockRestore(); }
  });

  it('rolls back replacement, grants and audit together on sealed-storage failure, without disclosure', async () => {
    const first = await mint();
    h.saveError = true;
    const response = await rotateRoute(request({ purpose }));
    const body = await response.json();
    responses.push(body);
    expect(response.status).toBe(503);
    expect(body).toEqual({ error: 'SSH CA unavailable' });
    expect(await rows()).toHaveLength(1);
    expect((await rows())[0].status).toBe('active');
    expect(await trusted()).toBe(`${first.publicKey}\n`);
  });

  it('rolls back revocation when a signed audit cannot be prepared', async () => {
    const first = await mint();
    vi.stubEnv('AUTH_PRIVATE_KEY', '');
    const response = await revokeRoute(request({ purpose, caId: first.caId }));
    responses.push(await response.json());
    expect(response.status).toBe(503);
    expect((await rows())[0].status).toBe('active');
    const [row] = await rows();
    const [grant] = await database.select().from(vaultDelegationGrants).where(eq(vaultDelegationGrants.id, row.grantId!));
    expect(grant.status).toBe('active');
  });

  it('refuses Tier 1 before generating a CA', async () => {
    vi.stubEnv('VAULT_OWNER_X_PUB', nodeKeys.publicKey);
    vi.stubEnv('VAULT_OWNER_ED_PUB', nodeKeys.publicKey);
    _resetSealingCache();
    const response = await mintRoute(request({ purpose }));
    responses.push(await response.json());
    expect(response.status).toBe(409);
    expect(h.seeds).toHaveLength(0);
    expect(await rows()).toHaveLength(0);
  });

  it('validates public wire keys rather than accepting malformed hex', () => {
    for (const invalid of ['', 'ab', 'z'.repeat(64), 'a'.repeat(66)]) {
      expect(() => sshCaPublicKey(invalid, purpose, 'vmk_test')).toThrow('Invalid CA public key');
    }
  });
});

describe('restricted SSH certificates (#3064)', () => {
  const grantee = 'did:imajin:runner';
  const clientKeys = generateKeypair();
  let input: Record<string, unknown>;
  let ca: Awaited<ReturnType<typeof mint>>;
  let grantId: string;
  async function invoke(body: unknown = input, raw?: string) {
    const response = await signRoute(raw === undefined ? request(body)
      : new Request('https://kernel.test/api/vault/ssh-ca/sign', { method: 'POST', body: raw }));
    const result = await response.json();
    responses.push(result);
    return { response, result };
  }
  beforeEach(async () => {
    ca = await mint();
    const response = await grantRoute(request({
      purpose, caId: ca.caId, grantee, principals: ['deploy'], forceCommand: '/usr/local/bin/deploy',
      allowedHosts: ['host.example.com'], expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    }));
    const body = await response.json();
    responses.push(body);
    expect(response.status).toBe(201);
    grantId = body.grantId;
    input = { purpose, caId: ca.caId, grantId, publicKey: sshCaPublicKey(clientKeys.publicKey, purpose, 'job').publicKey,
      principal: 'deploy', host: 'host.example.com', job: 'gha:repo/run/42' };
    h.auth = { identity: { id: grantee } };
  });

  it('returns an OpenSSH-parsed user cert, verifies the CA signature and binds restricted policy and signed audit', async () => {
    const { response, result } = await invoke();
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(result.ttl).toBe(600);
    const inspected = inspectCertificate(result.certificate);
    expect(inspected).toMatchObject({ principal: 'deploy', forceCommand: '/usr/local/bin/deploy',
      extensions: '', serial: result.serial, keyId: result.keyId, userType: 1 });
    expect(inspected.validBefore - inspected.validAfter).toBe(600);
    expect(acceptsCertificate(inspected, ca.publicKey, 'deploy', inspected.validAfter)).toBe(true);
    expect(acceptsCertificate(inspected, ca.publicKey, 'root', inspected.validAfter)).toBe(false);
    expect(acceptsCertificate(inspected, ca.publicKey, 'deploy', inspected.validBefore)).toBe(false);
    expect(acceptsCertificate(inspected, input.publicKey as string, 'deploy', inspected.validAfter)).toBe(false);
    expect(openSshAccepts(result.certificate, ca.publicKey, clientKeys.privateKey, 'deploy', inspected.validAfter)).toBe(true);
    expect(openSshAccepts(result.certificate, ca.publicKey, clientKeys.privateKey, 'root', inspected.validAfter)).toBe(false);
    expect(openSshAccepts(result.certificate, ca.publicKey, clientKeys.privateKey, 'deploy', inspected.validBefore)).toBe(false);
    expect(openSshAccepts(result.certificate, input.publicKey as string, clientKeys.privateKey, 'deploy', inspected.validAfter)).toBe(false);
    const issued = (await audits()).find(row => row.type === 'vault.ssh-cert.issued')!;
    expect(issued.payload).toMatchObject({
      job: input.job, grantee, principal: 'deploy', host: input.host, ttl: 600, serial: result.serial, keyId: result.keyId,
      publicKeyFingerprint: openSshPublicKeyFingerprint(input.publicKey as string),
    });
    expect(issued.payload).not.toHaveProperty('publicKey');
    expect(issued.payload).not.toHaveProperty('certificate');
    expect(JSON.stringify(issued.payload).includes(clientKeys.publicKey), 'Caller key material stored in audit').toBe(false);
    expect(crypto.verifySync(issued.signature, canonicalize({
      subject_did: issued.subjectDid, type: issued.type, context_id: issued.contextId,
      context_type: issued.contextType, payload: issued.payload, issued_at: issued.issuedAt.getTime(),
    }), nodeKeys.publicKey)).toBe(true);
    expect((await invoke({ ...input, ttl: 900 })).result.ttl).toBe(900);
    expect((await invoke()).result.serial).not.toBe(result.serial);
    expect(JSON.stringify(responses).includes(clientKeys.privateKey), 'Caller private material exposed').toBe(false);
  });

  it.each([
    { principal: '*' }, { principal: 'root' }, { host: 'other.example.com' }, { host: '*.example.com' },
    { ttl: 901 }, { ttl: 0 }, { ttl: -1 }, { ttl: 1.5 }, { ttl: '600' }, { ttl: null },
    { purpose: 'BAD' }, { caId: 'wrong' }, { grantId: 'wrong' }, { job: '' }, { job: 'a\nb' },
    { publicKey: 'ssh-rsa invalid' }, { publicKey: 'not a key' },
    { criticalOptions: { 'force-command': 'anything' } }, { extensions: ['permit-pty'] },
    { forceCommand: 'anything' }, { principals: ['root'] }, { privateKey: 'not-accepted' },
  ])('refuses invalid or widened signing request %j and audits refusal', async override => {
    const { response } = await invoke({ ...input, ...override });
    expect([400, 403]).toContain(response.status);
    expect((await audits()).filter(row => row.type === 'vault.ssh-cert.issued')).toHaveLength(0);
    const refusal = (await database.select().from(attestations)).filter(row => row.type === 'vault.ssh-cert.refused').at(-1)!;
    expect(refusal.payload).toEqual({ grantee, status: response.status });
  });

  it.each([null, [], 'bad'])('refuses non-object JSON %j', async body => {
    expect((await invoke(body)).response.status).toBe(400);
  });
  it('refuses malformed JSON', async () => { expect((await invoke(input, '{')).response.status).toBe(400); });
  it.each([401, 403])('refuses unauthenticated/unauthorised caller (%s)', async status => {
    h.auth = status === 401 ? { error: 'Not authenticated', status: 401 } : { identity: { id: 'did:imajin:outsider', actingDid: grantee } };
    expect((await invoke()).response.status).toBe(status);
  });
  it.each(['revoked', 'retiring', 'retired'])('refuses %s signer even with a live operation grant', async status => {
    await database.update(vaultMintedKeys).set({ status, revokedAt: new Date() }).where(eq(vaultMintedKeys.id, ca.caId));
    expect((await invoke()).response.status).toBe(403);
  });
  it('refuses anonymous callers without signing or writing any audit row', async () => {
    const before = await database.select().from(attestations);
    h.auth = { error: 'Not authenticated', status: 401 };
    vi.stubEnv('AUTH_PRIVATE_KEY', '');
    const prepare = vi.spyOn(mechanicalAudit, 'prepareMechanicalAttestation');
    const insert = vi.spyOn(database, 'insert');
    try {
      expect((await invoke()).response.status).toBe(401);
      expect(prepare).not.toHaveBeenCalled();
      expect(insert).not.toHaveBeenCalled();
      expect(await database.select().from(attestations)).toEqual(before);
    } finally { prepare.mockRestore(); insert.mockRestore(); }
  });
  it('bounds concurrent issuance per grant, audits 429, and allows issuance after the window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    vi.setSystemTime(start);
    const attempts = await Promise.all(Array.from({ length: SSH_CERT_ISSUANCE_LIMIT + 1 }, () => invoke()));
    expect(attempts.filter(attempt => attempt.response.status === 201)).toHaveLength(SSH_CERT_ISSUANCE_LIMIT);
    const refused = attempts.find(attempt => attempt.response.status === 429)!;
    expect(refused.result).not.toHaveProperty('certificate');
    expect((await audits()).filter(row => row.type === 'vault.ssh-cert.issued')).toHaveLength(SSH_CERT_ISSUANCE_LIMIT);
    const refusals = (await database.select().from(attestations)).filter(row => row.type === 'vault.ssh-cert.refused');
    expect(refusals.at(-1)?.payload).toEqual({ grantee, status: 429 });
    vi.setSystemTime(start + SSH_CERT_ISSUANCE_WINDOW_SECONDS * 1000 - 1);
    expect((await invoke()).response.status).toBe(429);
    vi.setSystemTime(start + SSH_CERT_ISSUANCE_WINDOW_SECONDS * 1000);
    expect((await invoke()).response.status).toBe(201);
  });
  it('does not spend a grant issuance budget on authenticated refusals or other grants', async () => {
    for (let attempt = 0; attempt < SSH_CERT_ISSUANCE_LIMIT; attempt++) {
      expect((await invoke({ ...input, principal: 'root' })).response.status).toBe(403);
    }
    expect((await invoke()).response.status).toBe(201);
    h.auth = { identity: { id: h.nodeDid } };
    const otherCa = await mintSshCa(`${purpose}-other`, authority());
    const response = await grantRoute(request({
      purpose: `${purpose}-other`, caId: otherCa.caId, grantee, principals: ['deploy'],
      forceCommand: '/usr/local/bin/deploy', allowedHosts: ['host.example.com'],
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    }));
    const otherGrant = await response.json();
    expect(response.status).toBe(201);
    h.auth = { identity: { id: grantee } };
    for (let attempt = 0; attempt < SSH_CERT_ISSUANCE_LIMIT; attempt++) {
      expect((await invoke({ ...input, purpose: `${purpose}-other`, caId: otherCa.caId, grantId: otherGrant.grantId }))
        .response.status).toBe(201);
    }
    expect((await invoke()).response.status).toBe(201);
  });
  it('does not reuse the old signer after rotation', async () => {
    await mint(true);
    expect((await invoke()).response.status).toBe(403);
  });
  it.each(['operation', 'custody'])('refuses expired or withdrawn %s grant', async kind => {
    const [row] = await rows();
    const id = kind === 'operation' ? grantId : row.grantId!;
    await database.update(vaultDelegationGrants).set({ expiresAt: new Date(Date.now() - 1) }).where(eq(vaultDelegationGrants.id, id));
    expect((await invoke()).response.status).toBe(403);
    await database.update(vaultDelegationGrants).set({ expiresAt: null, status: 'revoked' }).where(eq(vaultDelegationGrants.id, id));
    expect((await invoke()).response.status).toBe(403);
  });
  it('bounds certificate validity to the remaining signed grant lease', async () => {
    const [grant] = await database.select().from(vaultDelegationGrants).where(eq(vaultDelegationGrants.id, grantId));
    grant.expiresAt = new Date(Date.now() + 30_000);
    grant.ownerSignature = crypto.signSync(canonicalizeGrantPayload(grant), nodeKeys.privateKey);
    await database.update(vaultDelegationGrants).set({ expiresAt: grant.expiresAt, ownerSignature: grant.ownerSignature })
      .where(eq(vaultDelegationGrants.id, grantId));
    const { result, response } = await invoke();
    expect(response.status).toBe(201);
    expect(result.ttl).toBeLessThanOrEqual(30);
  });
  it('rejects tampered grant scope instead of trusting database JSON', async () => {
    await database.update(vaultDelegationGrants).set({ sshScope: {
      caId: ca.caId, principals: ['deploy', 'root'], forceCommand: 'sh', allowedHosts: ['host.example.com'],
    } }).where(eq(vaultDelegationGrants.id, grantId));
    expect((await invoke({ ...input, principal: 'root' })).response.status).toBe(403);
  });
  it('revokes via the same vault surface, retaining history and attestation', async () => {
    expect((await withdrawRoute(request({ purpose, grantId }))).status).toBe(403);
    h.auth = { identity: { id: h.nodeDid } };
    expect((await withdrawRoute(request({ purpose, grantId }))).status).toBe(200);
    expect((await withdrawRoute(request({ purpose, grantId }))).status).toBe(200);
    h.auth = { identity: { id: grantee } };
    expect((await invoke()).response.status).toBe(403);
    expect((await audits()).filter(row => row.type === 'vault.ssh-cert.grant-revoked')).toHaveLength(1);
    const [grant] = await database.select().from(vaultDelegationGrants).where(eq(vaultDelegationGrants.id, grantId));
    expect(grant.status).toBe('revoked');
    expect(grant.wrappedKey).toBe('');
    expect(await fetchGrantSecret({ grantId, granteeDid: grantee, kernelCredentialUse: true })).toEqual({ status: 'not_grantee' });
  });
  it.each([
    { principals: [] }, { principals: ['*'] }, { principals: ['root,deploy'] },
    { principals: Array(17).fill('deploy') }, { allowedHosts: [] }, { allowedHosts: ['*.example.com'] },
    { allowedHosts: Array(65).fill('host.example.com') }, { forceCommand: '' }, { forceCommand: ' ' },
    { forceCommand: 'a\nb' }, { forceCommand: '\0' }, { forceCommand: 'a'.repeat(2049) },
    { expiresAt: 'invalid' }, { expiresAt: '2000-01-01T00:00:00Z' }, { grantee: 'not-a-did' },
    { caId: 'wrong' }, { purpose: '*' }, { extensions: ['permit-pty'] },
  ])('refuses invalid grant policy %j without adding authority', async override => {
    h.auth = { identity: { id: h.nodeDid } };
    const response = await grantRoute(request({
      purpose, caId: ca.caId, grantee: 'did:imajin:another', principals: ['deploy'], forceCommand: '/bin/deploy',
      allowedHosts: ['host.example.com'], expiresAt: new Date(Date.now() + 60_000).toISOString(), ...override,
    }));
    expect(response.status).toBe(400);
    expect((await audits()).filter(row => row.type === 'vault.ssh-cert.grant-issued')).toHaveLength(1);
  });
  it('refuses grant creation by a non-operator or for the custody identity', async () => {
    const body = { purpose, caId: ca.caId, grantee: h.nodeDid, principals: ['deploy'], forceCommand: '/bin/deploy',
      allowedHosts: ['host.example.com'], expiresAt: new Date(Date.now() + 60_000).toISOString() };
    expect((await grantRoute(request(body))).status).toBe(403);
    h.auth = { identity: { id: h.nodeDid } };
    expect((await grantRoute(request(body))).status).toBe(400);
  });
  it('refuses missing grants, foreign purposes, and malformed revocation inputs', async () => {
    expect((await invoke({ ...input, grantId: 'vdg_missing' })).response.status).toBe(403);
    expect((await invoke({ ...input, purpose: `${purpose}-other` })).response.status).toBe(403);
    h.auth = { identity: { id: h.nodeDid } };
    expect((await withdrawRoute(request({ purpose, grantId: 'bad' }))).status).toBe(400);
    expect((await withdrawRoute(request({ purpose: `${purpose}-other`, grantId }))).status).toBe(404);
    expect((await grantRoute(request(null))).status).toBe(400);
  });
  it('enforces serial uniqueness in persistent storage', async () => {
    const { result } = await invoke();
    const [event] = (await audits()).filter(row => row.type === 'vault.ssh-cert.issued');
    await expect(database.insert(attestations).values({ ...event, id: `${event.id}_duplicate` })).rejects.toThrow();
    expect((await audits()).filter(row => row.payload?.serial === result.serial)).toHaveLength(1);
  });
  it('returns no certificate if audit signing fails, with generic error only', async () => {
    vi.stubEnv('AUTH_PRIVATE_KEY', '');
    const { response, result } = await invoke();
    expect(response.status).toBe(503);
    expect(result).toEqual({ error: 'SSH CA unavailable' });
    expect((await audits()).filter(row => row.type === 'vault.ssh-cert.issued')).toHaveLength(0);
  });

  it('bounds durable replay to token expiry, across grants, without consuming failed issuance', async () => {
    const fixture = await oidcFixture();
    const realVerify = githubOidc.verifyGithubJob;
    const spy = vi.spyOn(githubOidc, 'verifyGithubJob').mockImplementation(token => realVerify(token, fixture.keys));
    h.auth = { identity: { id: h.nodeDid } };
    const createGrant = async (p: string, caId: string) => {
      const response = await grantRoute(request({
        purpose: p, caId, repository: 'ima-jin/example', environment: 'production',
        repositoryId: '123', repositoryOwnerId: '456', principals: ['deploy'],
        forceCommand: '/bin/deploy', allowedHosts: ['host.example.com'],
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      }));
      expect(response.status).toBe(201);
      return response.json();
    };
    const first = await createGrant(purpose, ca.caId);
    const otherPurpose = `${purpose}-other`;
    const otherCa = await mintSshCa(otherPurpose, authority());
    const other = await createGrant(otherPurpose, otherCa.caId);
    const send = (token: string, p = purpose, caId = ca.caId, id = first.grantId) => {
      const body = { ...input, purpose: p, caId, grantId: id };
      delete body.job;
      return signRoute(new Request('https://kernel.test/api/vault/ssh-ca/sign', {
        method: 'POST', headers: { 'x-github-oidc-token': token }, body: JSON.stringify(body),
      }));
    };
    try {
      const token = await fixture.token({ jti: purpose });
      const failure = vi.spyOn(mechanicalAudit, 'prepareMechanicalAttestation')
        .mockRejectedValueOnce(new Error('issuance-audit-unavailable'));
      expect((await send(token)).status).toBe(503);
      failure.mockRestore();
      // No optional ref policy: another valid branch remains usable.
      const branch = await fixture.token({ jti: `${purpose}-branch`,
        workflow_ref: 'ima-jin/example/.github/workflows/deploy.yml@refs/heads/release' });
      expect((await send(branch)).status).toBe(201);
      expect((await send(token)).status).toBe(201);
      expect((await send(token, otherPurpose, otherCa.caId, other.grantId)).status).toBe(401);
      const start = Date.now();
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(start + 301_000);
      expect((await send(token)).status).toBe(401);
      // The expired marker leaves the active projection, but audit history stays.
      const renewed = await fixture.token({ jti: purpose });
      expect((await send(renewed)).status).toBe(201);
      expect((await audits()).filter(row => row.type === 'vault.ssh-cert.issued')).toHaveLength(3);
      expect((await send(renewed)).status).toBe(401);
    } finally { spy.mockRestore(); }
  });

  it('binds GitHub grants to repo/environment and signs verified job identity into issuance history', async () => {
    h.auth = { identity: { id: h.nodeDid } };
    const grantResponse = await grantRoute(request({
      purpose, caId: ca.caId, repository: 'ima-jin/example', environment: 'production',
      repositoryId: '123', repositoryOwnerId: '456',
      allowedRefs: ['ima-jin/example/.github/workflows/deploy.yml@refs/heads/main'],
      principals: ['deploy'], forceCommand: '/usr/local/bin/deploy', allowedHosts: ['host.example.com'],
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    }));
    expect(grantResponse.status).toBe(201);
    const grant = await grantResponse.json();
    expect(grant.github).toEqual({
      repository: 'ima-jin/example', environment: 'production', repositoryId: '123', repositoryOwnerId: '456',
      allowedRefs: ['ima-jin/example/.github/workflows/deploy.yml@refs/heads/main'],
    });
    const fixture = await oidcFixture();
    const realVerify = githubOidc.verifyGithubJob;
    const spy = vi.spyOn(githubOidc, 'verifyGithubJob').mockImplementation(token => realVerify(token, fixture.keys));
    const body: Record<string, unknown> = { ...input, grantId: grant.grantId };
    delete body.job;
    async function githubRequest(token: string, override = {}) {
      return signRoute(new Request('https://kernel.test/api/vault/ssh-ca/sign', {
        method: 'POST', headers: { 'x-github-oidc-token': token }, body: JSON.stringify({ ...body, ...override }),
      }));
    }
    try {
      const valid = await fixture.token();
      const attempts = await Promise.all([githubRequest(valid), githubRequest(valid)]);
      expect(attempts.map(response => response.status).sort()).toEqual([201, 401]);
      const response = attempts.find(response => response.status === 201)!;
      expect(response.status).toBe(201);
      const result = await response.json();
      expect(result.ttl).toBe(600);
      expect(inspectCertificate(result.certificate).principal).toBe('deploy');
      const issued = (await audits()).find(row => row.type === 'vault.ssh-cert.issued')!;
      expect(issued.payload?.githubJob).toEqual({
        repository: 'ima-jin/example', environment: 'production',
        repositoryId: '123', repositoryOwnerId: '456',
        workflow: 'ima-jin/example/.github/workflows/deploy.yml@refs/heads/main', runId: '42', runAttempt: '1',
        jtiHash: expect.stringMatching(/^[a-f0-9]{64}$/), expiresAt: expect.any(Number),
      });
      expect(crypto.verifySync(issued.signature, canonicalize({
        subject_did: issued.subjectDid, type: issued.type, context_id: issued.contextId,
        context_type: issued.contextType, payload: issued.payload, issued_at: issued.issuedAt.getTime(),
      }), nodeKeys.publicKey)).toBe(true);
      // Fresh requests use the database history, not a module-local replay cache.
      h.db = drizzle(client);
      expect((await githubRequest(valid)).status).toBe(401);
      for (const override of [
        { repository_id: '999' }, { repository_owner_id: '999' },
        { workflow_ref: 'ima-jin/example/.github/workflows/deploy.yml@refs/heads/other' },
        { workflow_ref: 'ima-jin/example/.github/workflows/deploy.yml@refs/tags/main' },
        { workflow_ref: 'ima-jin/example/.github/workflows/other.yml@refs/heads/main' },
      ]) {
        expect((await githubRequest(await fixture.token({ jti: JSON.stringify(override), ...override }))).status).toBe(403);
      }
      const [stored] = await database.select().from(vaultDelegationGrants)
        .where(eq(vaultDelegationGrants.id, grant.grantId));
      const legacyScope = { ...stored.sshScope! };
      delete legacyScope.github;
      const legacy = { ...stored, sshScope: legacyScope };
      await database.update(vaultDelegationGrants).set({
        sshScope: legacyScope, ownerSignature: crypto.signSync(canonicalizeGrantPayload(legacy), nodeKeys.privateKey),
      }).where(eq(vaultDelegationGrants.id, grant.grantId));
      const legacyResponse = await githubRequest(await fixture.token({ jti: 'legacy' }));
      expect(legacyResponse.status).toBe(403);
      expect(await legacyResponse.json()).toEqual({ error: 'GitHub grant missing repository ids; operator must re-grant' });
      // Changing either IDs or the ref list without re-signing cannot add authority.
      for (const github of [
        { ...stored.sshScope!.github!, repositoryId: '999' },
        { ...stored.sshScope!.github!, allowedRefs: undefined },
      ]) {
        await database.update(vaultDelegationGrants).set({
          sshScope: { ...stored.sshScope!, github }, ownerSignature: stored.ownerSignature,
        }).where(eq(vaultDelegationGrants.id, grant.grantId));
        expect((await githubRequest(await fixture.token({ jti: 'tampered' }))).status).toBe(403);
      }
      await database.update(vaultDelegationGrants).set({
        sshScope: stored.sshScope, ownerSignature: stored.ownerSignature,
      }).where(eq(vaultDelegationGrants.id, grant.grantId));
      expect((await githubRequest(await fixture.token({
        jti: 'wrong-repo',
        repository: 'ima-jin/other', sub: 'repo:ima-jin/other:environment:production',
        workflow_ref: 'ima-jin/other/.github/workflows/deploy.yml@refs/heads/main',
      }))).status).toBe(403);
      expect((await githubRequest(await fixture.token({
        jti: 'wrong-env', environment: 'dev', sub: 'repo:ima-jin/example:environment:dev',
      }))).status).toBe(403);
      expect((await githubRequest(await (await oidcFixture()).token())).status).toBe(401);
      expect((await githubRequest('', {})).status).toBe(401); // no fallback to node auth
      const refusals = (await database.select().from(attestations))
        .filter(row => row.type === 'vault.ssh-cert.refused' && row.payload?.authentication === 'github-oidc');
      expect(refusals.slice(-2).map(row => row.payload)).toEqual(Array(2).fill({
        status: 401, authentication: 'github-oidc', reason: 'invalid-token',
      }));
      expect(refusals.at(-1)?.subjectDid).toBe(h.nodeDid);
      const auditFailure = vi.spyOn(mechanicalAudit, 'prepareMechanicalAttestation')
        .mockRejectedValueOnce(new Error('unsafe-audit-error'));
      expect((await githubRequest('')).status).toBe(503);
      auditFailure.mockRestore();
      expect((await githubRequest(valid, { job: 'spoofed' })).status).toBe(400);
      expect((await githubRequest(valid, { privateKey: 'rejected' })).status).toBe(400);
      h.auth = { identity: { id: grant.grantee } };
      expect((await invoke({ ...input, grantId: grant.grantId })).response.status).toBe(401);
      h.auth = { identity: { id: h.nodeDid } };
      await withdrawRoute(request({ purpose, grantId: grant.grantId }));
      expect((await githubRequest(await fixture.token({ jti: 'revoked' }))).status).toBe(403);
      expect(JSON.stringify(await audits()).includes(valid), 'OIDC token persisted').toBe(false);
    } finally { spy.mockRestore(); }
  });

  it.each([
    { repository: 'ima-jin/example', environment: 'production', repositoryId: '123' },
    { repository: 'ima-jin/example', environment: 'production', repositoryOwnerId: '456' },
    { repository: 'ima-jin/example', environment: 'production', repositoryId: 123, repositoryOwnerId: '456' },
    { repository: 'ima-jin/example', environment: 'production', repositoryId: '123', repositoryOwnerId: '456', allowedRefs: [] },
    { repository: 'ima-jin/example', environment: 'production', repositoryId: '123', repositoryOwnerId: '456', allowedRefs: ['refs/heads/main'] },
    { repository: 'bad', environment: 'production' }, { repository: 'ima-jin/example' },
    { environment: 'production' }, { repository: 'ima-jin/example', environment: '' },
    { repository: 'ima-jin/example', environment: 'production', grantee: 'did:imajin:other' },
    { grantee: 'did:github:arbitrary' },
  ])('refuses ambiguous or invalid GitHub grant identity %j', async identity => {
    h.auth = { identity: { id: h.nodeDid } };
    expect((await grantRoute(request({
      purpose, caId: ca.caId, principals: ['deploy'], forceCommand: '/bin/deploy',
      allowedHosts: ['host.example.com'], expiresAt: new Date(Date.now() + 60_000).toISOString(), ...identity,
    }))).status).toBe(400);
  });
});
