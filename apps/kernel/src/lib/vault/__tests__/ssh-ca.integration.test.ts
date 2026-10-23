import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
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
    ...actual, requireAuth: vi.fn(async () => h.auth),
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
    // Independently parse RFC 8709; CI's minimal image has no ssh-keygen.
    // The same returned line was also checked with ssh-keygen locally.
    const wire = Buffer.from(text.split(' ')[1], 'base64');
    expect(wire.readUInt32BE(0)).toBe(11);
    expect(wire.subarray(4, 15).toString()).toBe('ssh-ed25519');
    expect(wire.readUInt32BE(15)).toBe(32);
    expect(wire.subarray(19).toString('hex')).toBe(record.publicKey);
    expect(wire.length).toBe(51);
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
    expect(grant.wrappedKey.length).toBe(0);
    const deadline = old.revokedAt!.getTime() + SSH_CA_MAX_CERT_TTL_SECONDS * 1000;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(deadline - 1);
    expect((await trusted()).trim().split('\n')).toHaveLength(2);
    vi.setSystemTime(deadline);
    // Fresh reads consult persistent state, not a timer or cached trust list.
    expect(await trusted()).toBe(`${second.publicKey}\n`);
    expect(await trusted()).toBe(`${second.publicKey}\n`);
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

  it('does not serve expired public trust if retirement audit signing fails', async () => {
    const first = await mint();
    await mint(true);
    const [old] = (await rows()).filter(row => row.id === first.caId);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(old.revokedAt!.getTime() + SSH_CA_MAX_CERT_TTL_SECONDS * 1000);
    vi.stubEnv('AUTH_PRIVATE_KEY', '');
    const response = await trustedRoute(new Request(`https://kernel.test/trusted-keys?purpose=${purpose}`));
    responses.push(await response.text());
    expect(response.status).toBe(503);
    expect((await rows()).find(row => row.id === first.caId)?.status).toBe('retiring');
    vi.stubEnv('AUTH_PRIVATE_KEY', nodeKeys.privateKey);
    expect(await trusted()).not.toContain(first.publicKey);
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
