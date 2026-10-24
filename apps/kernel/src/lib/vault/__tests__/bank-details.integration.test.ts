import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { verifyManifest, type SignedFairManifest } from '@imajin/fair';
import type { Identity } from '@imajin/auth';
import type { VaultFile } from '@imajin/vault-core';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const h = vi.hoisted(() => {
  vi.stubEnv('MEDIA_ROOT', `/tmp/bank-details-test-${process.pid}`);
  return {
    db: null as unknown, identity: {} as Identity,
    vault: { version: 1, entries: [] } as VaultFile, nodeDid: '',
    log: vi.fn(), publish: vi.fn(), saveError: false,
    authError: false, responses: [] as unknown[], inputs: [] as unknown[],
  };
});
vi.mock('@/src/db', async () => {
  const auth = await import('@/src/db/schemas/auth');
  const vault = await import('@/src/db/schemas/vault');
  const media = await import('@/src/db/schemas/media');
  const { forwardingDb } = await import('@/src/lib/notify/__tests__/pglite-connector-inbox-harness');
  return { ...auth, ...vault, ...media, db: forwardingDb(() => h.db) };
});
vi.mock('@imajin/auth', async importOriginal => ({
  ...await importOriginal<typeof import('@imajin/auth')>(),
  requireAuth: vi.fn(async () => h.authError ? { error: 'Unauthorized', status: 401 } : { identity: h.identity }),
}));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ debug: h.log, info: h.log, warn: h.log, error: h.log }) }));
vi.mock('@imajin/bus', () => ({ publish: h.publish }));
vi.mock('@imajin/dfos', () => ({ publishContentEvent: vi.fn().mockResolvedValue(null) }));
vi.mock('@/src/lib/media/blob-store-lore', () => ({ blobStore: { put: vi.fn().mockResolvedValue(null) } }));
vi.mock('@/src/lib/media/classify', () => ({ classifyAsset: vi.fn() }));
vi.mock('@/src/lib/media/folders', () => ({ getOrCreateSystemFolder: vi.fn() }));
vi.mock('@/src/lib/media/context-folder', () => ({ resolveContextFolder: vi.fn() }));
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeDid: vi.fn(async () => h.nodeDid) }));
vi.mock('../vault-repository', () => ({
  getVaultRepository: () => ({
    load: async () => structuredClone(h.vault),
    save: async (vault: VaultFile) => {
      if (h.saveError) throw new Error('Synthetic seal storage failure');
      h.vault = structuredClone(vault);
    },
  }),
}));

import { identities, attestations } from '@/src/db/schemas/auth';
import { assets } from '@/src/db/schemas/media';
import { vaultOwnerEnvelopes, vaultDelegationGrants, vaultGrantRequests } from '@/src/db/schemas/vault';
import { canonicalize, crypto, generateKeypair, requireAuth } from '@imajin/auth';
import { _resetSealingCache, getNodeSigningIdentity } from '../sealing';
import { readBankDetails } from '../bank-details';
import { bankDetailsSecrets, parseBankDetailsInput, validAba, validIban } from '../bank-details-schema';
import { parseReleasePolicy } from '@/src/lib/media/release-policy';
import { GET, PUT, DELETE, OPTIONS } from '@/app/auth/api/bank-details/route';
import { canonicalizeGrantPayload, fetchGrantSecret, listRenewableGrants, loadAndUnsealByGrantee } from '../index';

const nodeKeys = generateKeypair();
const tables = [identities, attestations, assets, vaultOwnerEnvelopes, vaultDelegationGrants, vaultGrantRequests];
let client: PGlite;
let database: ReturnType<typeof drizzle>;
let sequence = 0;
let owner: string;

function tableSql(table: PgTable) {
  const config = getTableConfig(table);
  const columns = config.columns.map(column => {
    let defaultSql = '';
    if (['created_at', 'updated_at', 'issued_at'].includes(column.name)) defaultSql = ' DEFAULT now()';
    else if (typeof column.default === 'string') defaultSql = ` DEFAULT '${column.default}'`;
    else if (typeof column.default === 'boolean' || typeof column.default === 'number') defaultSql = ` DEFAULT ${column.default}`;
    else if (column.getSQLType() === 'jsonb' && column.default !== undefined) defaultSql = ` DEFAULT '${JSON.stringify(column.default)}'::jsonb`;
    return `"${column.name}" ${column.getSQLType()}${column.primary ? ' PRIMARY KEY' : ''}${column.notNull ? ' NOT NULL' : ''}${defaultSql}`;
  });
  return `CREATE TABLE "${config.schema}"."${config.name}" (${columns.join(',')})`;
}

/** Fabricated bank identifiers only: reserved ABA prefix, fictitious bank code and repeated digits. */
function fakeIban() {
  const bban = 'FAKE' + '9'.repeat(14);
  const numeric = (bban + 'GB00').replaceAll(/[A-Z]/g, character => String(character.charCodeAt(0) - 55));
  let remainder = 0;
  for (const digit of numeric) remainder = (remainder * 10 + Number(digit)) % 97;
  return `GB${String(98 - remainder).padStart(2, '0')}${bban}`;
}
function fixture() {
  const input = {
    accountHolderName: 'Fictional Test Holder', bankName: 'FAKE TEST BANK — NOT AN ACCOUNT',
    country: 'CA', currency: 'CAD',
    eft: { institutionNumber: '999', transitNumber: '99999', accountNumber: '9'.repeat(12) },
    ach: { routingNumber: '999999992', accountNumber: '8'.repeat(13), accountType: 'checking' },
    wire: { routingNumber: '999999992', accountNumber: '7'.repeat(14), accountType: 'savings' },
    swift: { bic: 'FAKEGB00XXX', iban: fakeIban(), accountNumber: '6'.repeat(15) },
    visibility: { bankName: 'silent', country: 'on-consent', currency: 'never' },
  };
  h.inputs.push(input);
  return input;
}
async function call(method: typeof GET, input?: unknown, raw?: string) {
  const verb = method === PUT ? 'PUT' : method === DELETE ? 'DELETE' : 'GET';
  const response = await method(new NextRequest('https://kernel.test/auth/api/bank-details', {
    method: verb, ...(verb === 'PUT' ? { body: raw ?? JSON.stringify(input) } : {}),
  }));
  const body = await response.json();
  h.responses.push(body);
  return { status: response.status, body, headers: response.headers };
}

beforeAll(async () => {
  client = new PGlite();
  await client.waitReady;
  await client.exec('CREATE SCHEMA auth; CREATE SCHEMA kernel; CREATE SCHEMA media;');
  for (const table of tables) await client.exec(tableSql(table));
  await client.exec(`
    CREATE UNIQUE INDEX uniq_vwe ON kernel.vault_owner_envelopes (field,key_id);
    CREATE UNIQUE INDEX uniq_vault_delegation_active ON kernel.vault_delegation_grants (subject,granted_to,field,key_id) WHERE status='active';
  `);
  database = drizzle(client);
  h.db = database;
});
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv('AUTH_PRIVATE_KEY', nodeKeys.privateKey);
  vi.stubEnv('PLATFORM_DID', '');
  vi.stubEnv('VAULT_OWNER_X_PUB', '');
  vi.stubEnv('VAULT_OWNER_ED_PUB', '');
  _resetSealingCache();
  h.nodeDid = getNodeSigningIdentity().senderDid;
  owner = `did:imajin:banktest${++sequence}`;
  h.identity = { id: owner, scope: 'actor', subtype: 'human' };
  h.saveError = false;
  h.authError = false;
  h.responses = [];
  h.inputs = [];
  await database.insert(identities).values({ id: owner, publicKey: nodeKeys.publicKey, scope: 'actor', subtype: 'human' });
});
afterEach(async () => {
  const rows = await Promise.all(tables.map(table => database.select().from(table)));
  const media = await database.select().from(assets);
  const files = await Promise.all(media.map(async asset => [await readFile(asset.storagePath, 'utf8'), await readFile(asset.fairPath!, 'utf8')]));
  const exposed = JSON.stringify([rows, files, h.vault, h.responses, h.log.mock.calls, h.publish.mock.calls]);
  for (const raw of h.inputs) {
    const parsed = parseBankDetailsInput(raw);
    for (const [name, value] of bankDetailsSecrets(parsed)) {
      // Short institution/transit identifiers can coincide with arbitrary encrypted
      // bytes or timestamps; inspect their doc slots instead in the success test.
      if (value.length > 5) expect(exposed.includes(value), `${name} leaked into persisted/public data`).toBe(false);
    }
  }
});
afterAll(async () => {
  await client.close();
  vi.unstubAllEnvs();
  _resetSealingCache();
});

describe('bank-details: real SQL, vault-core encryption and signed document history', () => {
  it('stores one owner envelope per field and exposes capabilities without unsealing', async () => {
    const input = fixture();
    const identityBefore = await database.select().from(identities).where(eq(identities.id, owner));
    const saved = await call(PUT, input);
    expect(saved.status).toBe(201);
    const [asset] = await database.select().from(assets).where(eq(assets.id, saved.body.assetId));
    expect(asset).toMatchObject({ ownerDid: owner, immutable: true, status: 'active', fairManifest: { access: { type: 'private' } } });
    expect(await database.select().from(identities).where(eq(identities.id, owner))).toEqual(identityBefore);
    expect(await verifyManifest(asset.fairManifest as unknown as SignedFairManifest, async () => Buffer.from(nodeKeys.publicKey, 'hex'))).toEqual({ ok: true });
    const document = await readFile(asset.storagePath, 'utf8');
    const parsed = parseReleasePolicy(document);
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.data.kind).toBe('bank-details:v1');
    const secrets = bankDetailsSecrets(parseBankDetailsInput(input));
    const envelopes = await database.select().from(vaultOwnerEnvelopes);
    for (const [name, value] of secrets) {
      const reference = parsed.data[name] as { field: string; keyId: string };
      expect(reference).toMatchObject({ field: expect.stringContaining(saved.body.recordId), keyId: expect.any(String) });
      expect(parsed.releasePolicy[name].release).toBe('never');
      expect(envelopes.filter(row => row.field === reference.field && row.keyId === reference.keyId)).toHaveLength(1);
      // Trusted vault consumer only; never return the value from the bank-details API.
      const [grant] = await database.select().from(vaultDelegationGrants).where(eq(vaultDelegationGrants.field, reference.field));
      const recovered = await fetchGrantSecret({ grantId: grant.id, granteeDid: owner, kernelCredentialUse: true });
      expect(recovered.status === 'ok' && recovered.value === value, `${name} did not roundtrip through the real seal`).toBe(true);
      expect(await fetchGrantSecret({ grantId: grant.id, granteeDid: owner })).toEqual({ status: 'not_grantee' });
      expect(await fetchGrantSecret({ grantId: grant.id, granteeDid: 'did:imajin:stranger' })).toEqual({ status: 'not_grantee' });
      await expect(loadAndUnsealByGrantee(reference.field, owner)).rejects.toThrow();
    }
    expect(parsed.releasePolicy.bankName.release).toBe('silent');
    expect(parsed.releasePolicy.country.release).toBe('on-consent');
    expect(parsed.releasePolicy.currency.release).toBe('never');
    expect(parsed.releasePolicy.accountHolderName.release).toBe('owner-only');
    expect(await listRenewableGrants({ nodeDid: h.nodeDid })).toEqual([]);
    // A corrupt/absent vault cannot affect this no-unseal projection.
    const retainedVault = h.vault;
    h.vault = { version: 1, entries: [] };
    const projection = await readBankDetails(owner);
    for (const rail of ['eft', 'ach', 'wire', 'swift'] as const) expect(projection?.hasRail(rail)).toBe(true);
    const response = await call(GET);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.body).not.toHaveProperty('sealed');
    expect(response.body.hasRail).toEqual({ eft: true, ach: true, wire: true, swift: true });
    h.vault = retainedVault;
    expect(requireAuth).toHaveBeenCalledWith(expect.anything(), { service: 'auth', sessionOnly: true });
    const [audit] = await database.select().from(attestations).where(eq(attestations.contextId, saved.body.recordId));
    expect(crypto.verifySync(audit.signature, canonicalize({
      subject_did: owner, type: audit.type, context_id: audit.contextId, context_type: audit.contextType,
      payload: audit.payload, issued_at: audit.issuedAt.getTime(),
    }), nodeKeys.publicKey)).toBe(true);
  });

  it('replaces then deletes with retained history, superseded grants, and idempotent 404', async () => {
    const first = await call(PUT, fixture());
    const secondInput = fixture();
    const second = await call(PUT, { ...secondInput, ach: undefined, wire: undefined, swift: undefined });
    expect(second.status).toBe(201);
    const [old] = await database.select().from(assets).where(eq(assets.id, first.body.assetId));
    expect(old.status).toBe('superseded');
    const projection = await readBankDetails(owner);
    expect(projection?.hasRail('eft')).toBe(true);
    expect(projection?.hasRail('ach')).toBe(false);
    expect(projection?.hasRail('wire')).toBe(false);
    expect(projection?.hasRail('swift')).toBe(false);
    const grantsBefore = await database.select().from(vaultDelegationGrants).where(eq(vaultDelegationGrants.subject, owner));
    expect(grantsBefore.filter(grant => grant.status === 'active')).toHaveLength(3);
    const source = grantsBefore.find(grant => grant.status === 'active')!;
    const recipientGrant = { ...source, id: `grant_recipient_${sequence}`, grantedTo: 'did:imajin:fakepayer' };
    await database.insert(vaultDelegationGrants).values({
      ...recipientGrant, ownerSignature: crypto.signSync(canonicalizeGrantPayload(recipientGrant), nodeKeys.privateKey),
    });
    const envelopeCount = (await database.select().from(vaultOwnerEnvelopes)).length;
    const deleted = await call(DELETE);
    expect(deleted.status).toBe(200);
    expect(await readBankDetails(owner)).toBeNull();
    const grants = await database.select().from(vaultDelegationGrants).where(eq(vaultDelegationGrants.subject, owner));
    expect(grants.length).toBe(grantsBefore.length + 1);
    for (const grant of grants) {
      expect(grant).toMatchObject({ status: 'superseded', wrappedKey: '', wrappedNonce: '' });
      expect(await fetchGrantSecret({ grantId: grant.id, granteeDid: grant.grantedTo, kernelCredentialUse: true })).toEqual({ status: 'inactive' });
    }
    expect((await database.select().from(vaultOwnerEnvelopes)).length).toBe(envelopeCount);
    const [retained] = await database.select().from(assets).where(eq(assets.id, second.body.assetId));
    expect(retained.status).toBe('deleted');
    expect(await readFile(retained.storagePath, 'utf8')).toContain(second.body.recordId);
    const audit = await database.select().from(attestations).where(eq(attestations.subjectDid, owner));
    expect(audit.map(row => row.type)).toEqual(['document.created', 'document.revoked', 'document.created', 'document.revoked']);
    expect((await call(DELETE)).status).toBe(404);
    expect((await call(GET)).status).toBe(404);
    expect(await listRenewableGrants({ nodeDid: h.nodeDid })).toEqual([]);
  });

  it('does not expose or mutate another DID record', async () => {
    const saved = await call(PUT, fixture());
    h.identity = { id: 'did:imajin:stranger', scope: 'actor', subtype: 'human' };
    expect((await call(GET)).status).toBe(404);
    expect((await call(DELETE)).status).toBe(503);
    const [asset] = await database.select().from(assets).where(eq(assets.id, saved.body.assetId));
    expect(asset.status).toBe('active');
  });

  it('rolls back DB state when sealing fails, retaining the previous active record', async () => {
    const saved = await call(PUT, fixture());
    const before = await database.select().from(vaultOwnerEnvelopes);
    h.saveError = true;
    expect((await call(PUT, fixture())).status).toBe(503);
    const after = await database.select().from(vaultOwnerEnvelopes);
    expect(after.length).toBe(before.length);
    const projection = await readBankDetails(owner);
    expect(projection?.recordId).toBe(saved.body.recordId);
  });

  it('rolls back revocation if its attestation cannot be signed', async () => {
    const saved = await call(PUT, fixture());
    vi.stubEnv('AUTH_PRIVATE_KEY', '');
    expect((await call(DELETE)).status).toBe(503);
    expect((await readBankDetails(owner))?.recordId).toBe(saved.body.recordId);
    const grants = await database.select().from(vaultDelegationGrants).where(eq(vaultDelegationGrants.subject, owner));
    expect(grants.every(grant => grant.status === 'active' && grant.wrappedKey.length > 0)).toBe(true);
  });

  it('refuses missing signing custody and unsupported Tier 1 before writing', async () => {
    vi.stubEnv('AUTH_PRIVATE_KEY', '');
    expect((await call(PUT, fixture())).status).toBe(503);
    vi.stubEnv('AUTH_PRIVATE_KEY', nodeKeys.privateKey);
    vi.stubEnv('VAULT_OWNER_X_PUB', 'configured');
    vi.stubEnv('VAULT_OWNER_ED_PUB', 'configured');
    expect((await call(PUT, fixture())).status).toBe(503);
    expect(await readBankDetails(owner)).toBeNull();
  });
});

describe('bank-details API permission boundaries', () => {
  it('rejects anonymous callers on every operation', async () => {
    h.authError = true;
    for (const method of [GET, PUT, DELETE]) expect((await call(method, fixture())).status).toBe(401);
  });
  it.each([
    { actingFor: 'did:imajin:principal' },
    { subtype: 'agent' },
    { actingAs: 'did:imajin:org', actingAsRole: 'member' },
  ])('rejects delegated, agent and non-admin org callers', async identity => {
    h.identity = { ...h.identity, ...identity } as Identity;
    for (const method of [GET, PUT, DELETE]) expect((await call(method, fixture())).status).toBe(403);
  });
  it('pins organization ownership to canonical act-as, retaining the actual human', async () => {
    const org = 'did:imajin:bankorg';
    await database.insert(identities).values({ id: org, publicKey: nodeKeys.publicKey, scope: 'business', subtype: 'organization' });
    h.identity = { ...h.identity, actingAs: org, actingAsRole: 'admin' };
    const saved = await call(PUT, fixture());
    expect(saved.status).toBe(201);
    const [asset] = await database.select().from(assets).where(eq(assets.id, saved.body.assetId));
    expect(asset).toMatchObject({ ownerDid: org, uploadedBy: owner });
    expect((await call(DELETE)).status).toBe(200);
  });
  it('supports preflight without disclosing a record', () => {
    const result = OPTIONS(new NextRequest('https://kernel.test/auth/api/bank-details', { method: 'OPTIONS' }));
    expect(result.status).toBe(204);
  });
});

describe('bank-details validation: field-named 400 and no values echoed', () => {
  const invalid = [
    ['accountHolderName', ''], ['accountHolderName', 'x'.repeat(201)],
    ['bankName', ''], ['bankName', 'x'.repeat(201)], ['country', 'can'], ['currency', 'cad'],
    ['eft.institutionNumber', '99'], ['eft.institutionNumber', 'aaa'],
    ['eft.transitNumber', '9999'], ['eft.transitNumber', 'abcde'],
    ['eft.accountNumber', ''], ['eft.accountNumber', 'letters'], ['eft.accountNumber', '9'.repeat(35)],
    ['ach.routingNumber', '999999991'], ['ach.routingNumber', '0'.repeat(9)], ['ach.routingNumber', '9'.repeat(8)],
    ['ach.accountNumber', '9'.repeat(18)], ['ach.accountType', 'other'],
    ['wire.routingNumber', 'not-a-routing'], ['wire.accountNumber', 'abc'], ['wire.accountType', 'other'],
    ['swift.bic', 'INVALID'], ['swift.iban', 'GB00' + '9'.repeat(18)], ['swift.iban', 'lowercase'],
    ['swift.accountNumber', 'abc'], ['visibility.bankName', 'public'],
  ] as const;
  it.each(invalid)('rejects invalid %s', async (field, value) => {
    const input = fixture() as unknown as Record<string, unknown>;
    const [head, tail] = field.split('.');
    // Keep the pristine fixture for the leak audit; mutate a separate request.
    const changed = structuredClone(input);
    if (tail) (changed[head] as Record<string, unknown>)[tail] = value;
    else changed[head] = value;
    const response = await call(PUT, changed);
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: `Invalid field: ${field}`, field });
    expect(await readBankDetails(owner)).toBeNull();
  });
  it('requires a rail and a SWIFT destination, rejects forged ownership, secret visibility and malformed JSON', async () => {
    const input = fixture();
    expect((await call(PUT, { ...input, eft: undefined, ach: undefined, wire: undefined, swift: undefined })).body.field).toBe('rails');
    expect((await call(PUT, { ...input, swift: { bic: input.swift.bic } })).body.field).toBe('swift.iban');
    expect((await call(PUT, { ...input, ownerDid: 'did:imajin:stranger' })).status).toBe(400);
    expect((await call(PUT, { ...input, visibility: { 'eft.accountNumber': 'silent' } })).status).toBe(400);
    expect((await call(PUT, undefined, '{')).body.field).toBe('body');
    expect((await call(PUT, null)).body.field).toBe('body');
  });
  it('validates synthetic checksum fixtures and accepts 8-character BIC / account-only SWIFT', async () => {
    expect(validAba(fixture().ach.routingNumber)).toBe(true);
    expect(validIban(fakeIban())).toBe(true);
    expect(validIban('GB00' + fakeIban().slice(4))).toBe(false);
    const response = await call(PUT, { ...fixture(), swift: { bic: 'FAKEGB00', accountNumber: '5'.repeat(10) } });
    expect(response.status).toBe(201);
  });
});
