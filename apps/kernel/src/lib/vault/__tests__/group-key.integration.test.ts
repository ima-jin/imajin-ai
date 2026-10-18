import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Identity } from '@imajin/auth';
import type { VaultFile } from '@imajin/vault-core';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const h = vi.hoisted(() => ({
  db: null as unknown,
  identity: { id: 'did:imajin:human', scope: 'actor', subtype: 'human' } as Identity,
  nodeDid: '', vault: { version: 1, entries: [] } as VaultFile,
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
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ debug: h.log, info: h.log, warn: h.log, error: h.log }) }));
vi.mock('@/src/lib/kernel/node-identity', () => ({
  getNodeDid: vi.fn(async () => h.nodeDid),
  getNodeDidFromConfig: vi.fn(async () => h.nodeDid),
}));
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
import { identities, identityMembers, storedKeys, attestations } from '@/src/db/schemas/auth';
import { vaultDelegationGrants, vaultOwnerEnvelopes, vaultGrantRequests } from '@/src/db/schemas/vault';
import { operatorApprovals } from '@/src/db/schemas/operator-approvals';
import { NextRequest } from 'next/server';
import { POST } from '@/app/jin/api/vault-proposals/route';
import { canonicalize, crypto, generateKeypair, requireAuth } from '@imajin/auth';
import { getOperatorDid } from '@/src/lib/notify/operator-approvals';
import { pushWebNotificationToOperator } from '@/src/lib/notify/web-push';
import { encryptPrivateKey } from '@/src/lib/auth/crypto';
import { decideOperatorApproval, type OperatorApprovalCard } from '@/src/lib/notify/operator-approvals-service';
import { executeVaultApproval } from '../approvals-execution';
import { executeGroupKeyApproval } from '../group-key';
import { getNodeSigningIdentity, _resetSealingCache } from '../sealing';
import { fetchPurposeCredential } from '../purpose-credential';
import { listOtherActiveGrantees, getRotateGranteeGuard } from '../grantees';
import { domainSigningIdentity } from '@/src/lib/domains/signing';
import { fetchGrantSecret, listGrantsForGrantee, sealAndGrantStaticSecret, vaultService } from '../index';

const HUMAN = 'did:imajin:human';
const ORG = 'did:imajin:organization';
const personKeys = generateKeypair();
const nodeKeys = generateKeypair();
const tables = [identities, identityMembers, storedKeys, attestations, vaultDelegationGrants, vaultOwnerEnvelopes, vaultGrantRequests, operatorApprovals];
let client: PGlite;
let db: ReturnType<typeof drizzle>;
let seed: string;
let responses: unknown[];

// Same real-column/default harness as import.integration.test.ts; retain production uniqueness.
function createTable(table: PgTable) {
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
  client = new PGlite();
  await client.waitReady;
  await client.exec('CREATE SCHEMA auth; CREATE SCHEMA kernel; CREATE SCHEMA operator;');
  for (const table of tables) await client.exec(createTable(table));
  await client.exec(`
    CREATE UNIQUE INDEX uniq_stored_did ON auth.stored_keys (did);
    CREATE UNIQUE INDEX uniq_vwe ON kernel.vault_owner_envelopes (field,key_id);
    CREATE UNIQUE INDEX uniq_vault_delegation_active ON kernel.vault_delegation_grants (subject,granted_to,field,key_id) WHERE status='active';
  `);
  db = drizzle(client);
  h.db = db;
});
afterAll(async () => { await client.close(); });
beforeEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.mocked(getOperatorDid).mockResolvedValue(HUMAN);
  vi.mocked(requireAuth).mockImplementation(async () => ({ identity: h.identity }));
  vi.mocked(pushWebNotificationToOperator).mockResolvedValue(undefined);
  h.publish.mockResolvedValue(undefined);
  h.emit.mockResolvedValue(undefined);
  vi.stubEnv('AUTH_PRIVATE_KEY', nodeKeys.privateKey);
  vi.stubEnv('GROUP_KEY_ENCRYPTION_SECRET', randomBytes(32).toString('hex'));
  vi.stubEnv('PLATFORM_DID', ORG);
  vi.stubEnv('VAULT_OWNER_X_PUB', '');
  vi.stubEnv('VAULT_OWNER_ED_PUB', '');
  vi.stubEnv('OPERATOR_COUNTERSIGN_REQUIRED', 'true');
  _resetSealingCache();
  h.nodeDid = getNodeSigningIdentity().senderDid;
  h.saveError = null;
  h.vault = { version: 1, entries: [] };
  h.identity = { id: HUMAN, scope: 'actor', subtype: 'human' };
  responses = [];
  const groupKeys = generateKeypair();
  seed = groupKeys.privateKey;
  for (const table of tables) await db.delete(table);
  await db.insert(identities).values([
    { id: HUMAN, scope: 'actor', subtype: 'human', publicKey: personKeys.publicKey, tier: 'established' },
    { id: ORG, scope: 'business', subtype: 'organization', handle: 'imajin', publicKey: groupKeys.publicKey, tier: 'established' },
    { id: h.nodeDid, scope: 'actor', subtype: 'agent', publicKey: nodeKeys.publicKey, tier: 'established' },
  ]);
  await db.insert(identityMembers).values({ identityDid: ORG, memberDid: HUMAN, role: 'admin' });
  await db.insert(storedKeys).values({ id: 'stored_group', did: ORG, ...await encryptPrivateKey(seed), keyDerivation: 'pbkdf2' });
});
afterEach(async () => {
  // Deliberately exclude the two trusted in-process credential return values, which MUST carry the seed.
  // All persisted rows, public responses, errors, log calls, events and snapshot inputs must be value-free.
  const rows = await Promise.all(tables.map(table => db.select().from(table)));
  const visible = JSON.stringify([responses, rows, h.vault, h.log.mock.calls, h.emit.mock.calls, h.publish.mock.calls]);
  expect(visible.includes(seed), 'generated group seed leaked outside the trusted credential return').toBe(false);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  _resetSealingCache();
});

async function propose(kind = 'custody-group-key', detail: Record<string, unknown> = { groupDid: ORG, purpose: 'domain.issue' }) {
  const response = await POST(new NextRequest('https://kernel.test/jin/api/vault-proposals', {
    method: 'POST', body: JSON.stringify({ kind, detail }), headers: { 'Content-Type': 'application/json' },
  }));
  const body = await response.json();
  responses.push(body);
  return { status: response.status, body };
}
async function approval(kind = 'custody-group-key') {
  const proposal = await propose(kind);
  expect(proposal.status, JSON.stringify(proposal.body)).toBe(201);
  const [row] = await db.select().from(operatorApprovals).where(eq(operatorApprovals.proposalId, proposal.body.proposalId));
  const decidedAt = new Date().toISOString();
  const sig = crypto.signSync(canonicalize({ contentHash: row.contentHash!, decision: 'approve', decidedAt }), personKeys.privateKey);
  const decided = await decideOperatorApproval({
    proposalId: row.proposalId, operatorDid: HUMAN, decision: 'approve', decidedAt,
    operatorSignature: { keyId: personKeys.publicKey, alg: 'ed25519', sig },
  });
  responses.push(decided);
  if (!decided.ok) throw new Error(decided.error);
  expect(decided.card.decision?.contentHash).toBe(`sha256:${row.contentHash}`);
  return decided.card;
}
async function execute(card: OperatorApprovalCard) {
  const result = await executeVaultApproval(card);
  responses.push(result);
  return result;
}
async function expectCredentialUnavailable(operation: Promise<unknown>) {
  const error = await operation.then(() => null, value => value as Error & { code?: string });
  expect(error).toMatchObject({ code: 'credential_unavailable' });
  responses.push({ message: error?.message, stack: error?.stack, cause: error?.cause, code: error?.code });
}
async function expectNoCustody(card: OperatorApprovalCard) {
  expect(await execute(card)).toMatchObject({ ok: false });
  expect(await db.select().from(vaultDelegationGrants)).toEqual([]);
  expect(await db.select().from(vaultOwnerEnvelopes)).toEqual([]);
  expect(await db.select().from(attestations)).toEqual([]);
  expect(h.vault.entries).toEqual([]);
  const [stored] = await db.select().from(storedKeys);
  if (stored) expect(stored.lastUsedAt).toBeNull();
  const [proposal] = await db.select().from(operatorApprovals).where(eq(operatorApprovals.proposalId, card.proposalId));
  expect(proposal.status).toBe('approved');
}
function verifyAudit(row: typeof attestations.$inferSelect) {
  expect(row.issuerDid).toBe(h.nodeDid);
  expect(row.subjectDid).toBe(ORG);
  expect(row.contextType).toBe('vault.group-key');
  expect(row.attestationStatus).toBeNull();
  expect(crypto.verifySync(row.signature, canonicalize({
    subject_did: row.subjectDid, type: row.type, context_id: row.contextId,
    context_type: row.contextType, payload: row.payload, issued_at: row.issuedAt.getTime(),
  }), nodeKeys.publicKey)).toBe(true);
  expect(row.payload).toMatchObject({
    groupDid: ORG, nodeDid: h.nodeDid, purpose: 'domain.issue',
    authorizedBy: { operatorDid: HUMAN, approvalId: row.contextId },
  });
}

describe('group custody — real SQL, operator countersignatures, encryption and audit', () => {
  it('proposes without credential writes, then countersigns, executes, fetches and revokes with signed audit and key erasure', async () => {
    const card = await approval();
    expect(await db.select().from(vaultDelegationGrants)).toEqual([]);
    expect(h.vault.entries).toEqual([]);
    await expectCredentialUnavailable(fetchPurposeCredential(ORG, h.nodeDid, 'domain.issue'));
    expect(await execute(card)).toEqual({ ok: true });
    const [grant] = await db.select().from(vaultDelegationGrants);
    expect(grant).toMatchObject({ subject: ORG, grantedTo: h.nodeDid, purpose: 'domain.issue', oneTime: false, expiresAt: null, status: 'active' });
    const grantees = await listOtherActiveGrantees(grant.field, h.nodeDid);
    responses.push(grantees);
    expect(grantees).toEqual([{ grantId: grant.id, grantedTo: h.nodeDid, purpose: 'domain.issue', oneTime: false, expiresAt: null }]);
    expect(await getRotateGranteeGuard(grant.field, h.nodeDid)).toEqual({ grantees, reissuedOnRotate: false });
    expect(h.vault.entries[0]).toMatchObject({ version: 2, field: `vault-group-key:${card.proposalId}`, custodyScheme: 'delegation-grant' });
    expect(await fetchPurposeCredential(ORG, h.nodeDid, 'domain.issue') === seed).toBe(true);
    const signer = await domainSigningIdentity(true);
    expect(signer.issuerDid).toBe(ORG);
    expect(signer.privateKey === seed).toBe(true);
    expect((await db.select().from(storedKeys))[0].lastUsedAt).toBeInstanceOf(Date);
    const [importAudit] = await db.select().from(attestations);
    verifyAudit(importAudit);
    const revoked = await approval('revoke-group-key');
    expect(await execute(revoked)).toEqual({ ok: true });
    const [erased] = await db.select().from(vaultDelegationGrants);
    expect(erased).toMatchObject({ status: 'revoked', wrappedKey: '', wrappedNonce: '' });
    expect(erased.revokedAt).toBeInstanceOf(Date);
    await expectCredentialUnavailable(fetchPurposeCredential(ORG, h.nodeDid, 'domain.issue'));
    await expectCredentialUnavailable(domainSigningIdentity(true));
    expect(await fetchGrantSecret({ grantId: grant.id, granteeDid: h.nodeDid })).toEqual({ status: 'inactive' });
    const audit = await db.select().from(attestations);
    expect(audit).toHaveLength(2);
    audit.forEach(verifyAudit);
    const snapshot = {
      proposalStatus: (await db.select().from(operatorApprovals)).map(row => row.status),
      auditTypes: audit.map(row => row.type).sort(),
      auditPayloadKeys: Object.keys(importAudit.payload!).sort(),
      grant: { status: erased.status, wrappedKey: erased.wrappedKey, wrappedNonce: erased.wrappedNonce },
    };
    expect(JSON.stringify(snapshot).includes(seed)).toBe(false);
    expect(snapshot).toMatchInlineSnapshot(`
      {
        "auditPayloadKeys": [
          "action",
          "authorizedBy",
          "field",
          "grantId",
          "groupDid",
          "nodeDid",
          "publicKey",
          "purpose",
        ],
        "auditTypes": [
          "vault.key.imported",
          "vault.key.revoked",
        ],
        "grant": {
          "status": "revoked",
          "wrappedKey": "",
          "wrappedNonce": "",
        },
        "proposalStatus": [
          "applied",
          "applied",
        ],
      }
    `);
  });

  it('refuses an unsigned decision even when the global countersign flag is disabled', async () => {
    const proposal = await propose();
    vi.stubEnv('OPERATOR_COUNTERSIGN_REQUIRED', 'false');
    const decided = await decideOperatorApproval({ proposalId: proposal.body.proposalId, operatorDid: HUMAN, decision: 'approve' });
    expect(decided.ok).toBe(true);
    if (!decided.ok) throw new Error('Expected witnessed but unsigned approval');
    await expectNoCustody(decided.card);
  });

  it('rejects missing and invalid signatures at the real decision service', async () => {
    const proposal = await propose();
    const base = { proposalId: proposal.body.proposalId, operatorDid: HUMAN, decision: 'approve' as const };
    expect(await decideOperatorApproval(base)).toMatchObject({ ok: false, status: 400 });
    expect(await decideOperatorApproval({
      ...base, decidedAt: new Date().toISOString(),
      operatorSignature: { keyId: personKeys.publicKey, alg: 'ed25519', sig: '00'.repeat(64) },
    })).toMatchObject({ ok: false, status: 400 });
    expect((await db.select().from(operatorApprovals))[0].status).toBe('pending');
    expect(h.vault.entries).toEqual([]);
  });

  it.each([
    'summary', 'purpose', 'groupDid', 'nodeDid', 'kind', 'operatorDid', 'source', 'keysTouched',
    'signature', 'decidedAt', 'contentHash', 'status',
  ])('rejects a countersigned card mutated at %s', async field => {
    const card = structuredClone(await approval());
    if (['purpose', 'groupDid', 'nodeDid'].includes(field)) card.detail![field] = field === 'purpose' ? 'other' : 'did:imajin:other';
    else if (field === 'signature') card.decision!.operatorSignature!.sig = '00'.repeat(64);
    else if (field === 'decidedAt') card.decision!.decidedAt = new Date(Date.now() - 1000).toISOString();
    else if (field === 'contentHash') card.decision!.contentHash = 'sha256:' + '00'.repeat(32);
    else if (field === 'keysTouched') card.keysTouched = ['other'];
    else if (field === 'status') card.status = 'denied';
    else if (field === 'kind') card.kind = 'vault:revoke-group-key';
    else if (field === 'operatorDid') card.operatorDid = 'did:imajin:other';
    else card[field as 'summary' | 'source'] = 'changed';
    await expectNoCustody(card);
  });

  it('refuses changes to the persisted proposal even when the in-memory card is intact', async () => {
    const card = await approval();
    await db.update(operatorApprovals).set({ detail: { ...card.detail, purpose: 'other' } });
    await expectNoCustody(card);
  });

  it.each(['role', 'removed', 'deleted', 'restricted', 'operator-key', 'suspended'])('rechecks current authority after signing: %s', async change => {
    const card = await approval();
    if (change === 'role') await db.update(identityMembers).set({ role: 'member' });
    if (change === 'removed') await db.update(identityMembers).set({ removedAt: new Date() });
    if (change === 'deleted') await db.delete(identityMembers);
    if (change === 'restricted') await db.update(identityMembers).set({ allowedServices: ['pay'] });
    if (change === 'operator-key') await db.update(identities).set({ publicKey: generateKeypair().publicKey }).where(eq(identities.id, HUMAN));
    if (change === 'suspended') await db.update(identities).set({ suspendedAt: new Date() }).where(eq(identities.id, ORG));
    await expectNoCustody(card);
  });

  it('rejects removed and service-restricted admins at proposal time, but allows vault-scoped admins', async () => {
    await db.update(identityMembers).set({ allowedServices: ['pay'] });
    expect((await propose()).status).toBe(403);
    await db.update(identityMembers).set({ allowedServices: ['vault'], removedAt: new Date() });
    expect((await propose()).status).toBe(403);
    await db.update(identityMembers).set({ removedAt: null });
    expect(await execute(await approval())).toEqual({ ok: true });
  });

  it('rejects Tier 1 at proposal time and rechecks Tier 1 after countersigning without queueing requests', async () => {
    const card = await approval();
    vi.stubEnv('VAULT_OWNER_X_PUB', generateKeypair().publicKey);
    vi.stubEnv('VAULT_OWNER_ED_PUB', generateKeypair().publicKey);
    expect((await propose()).status).toBe(403);
    await expectNoCustody(card);
    expect(await db.select().from(vaultGrantRequests)).toEqual([]);
  });

  it.each(['missing-secret', 'wrong-secret', 'missing-ciphertext', 'tampered-ciphertext', 'wrong-ciphertext', 'current-public-key'])('fails closed without partial writes for %s', async failure => {
    const card = await approval();
    if (failure === 'missing-secret') vi.stubEnv('GROUP_KEY_ENCRYPTION_SECRET', '');
    if (failure === 'wrong-secret') vi.stubEnv('GROUP_KEY_ENCRYPTION_SECRET', randomBytes(32).toString('hex'));
    if (failure === 'missing-ciphertext') await db.delete(storedKeys);
    if (failure === 'tampered-ciphertext') {
      const [stored] = await db.select().from(storedKeys);
      const bytes = Buffer.from(stored.encryptedKey, 'base64');
      bytes[20] ^= 1;
      await db.update(storedKeys).set({ encryptedKey: bytes.toString('base64') });
    }
    if (failure === 'wrong-ciphertext') await db.update(storedKeys).set(await encryptPrivateKey(generateKeypair().privateKey));
    if (failure === 'current-public-key') await db.update(identities).set({ publicKey: generateKeypair().publicKey }).where(eq(identities.id, ORG));
    await expectNoCustody(card);
  });

  it('rejects sequential replay and a duplicate purpose on a different proposal', async () => {
    const first = await approval();
    const second = await approval();
    expect(await execute(first)).toEqual({ ok: true });
    const original = structuredClone(h.vault);
    expect(await execute(first)).toMatchObject({ ok: false });
    expect(await execute(second)).toMatchObject({ ok: false });
    expect(await db.select().from(vaultDelegationGrants)).toHaveLength(1);
    expect(await db.select().from(attestations)).toHaveLength(1);
    expect(h.vault).toEqual(original);
  });

  it('rejects a pre-existing active purpose grant even when its field is not a custody field', async () => {
    await sealAndGrantStaticSecret('other-provider:domain', randomBytes(16).toString('hex'), {
      principalDid: ORG, granteeDid: h.nodeDid, purpose: 'domain.issue',
    });
    const original = structuredClone(h.vault);
    expect(await execute(await approval())).toMatchObject({ ok: false });
    expect(await db.select().from(vaultDelegationGrants)).toHaveLength(1);
    expect(await db.select().from(attestations)).toEqual([]);
    expect(h.vault).toEqual(original);
    expect(await execute(await approval('revoke-group-key'))).toMatchObject({ ok: false });
    expect((await db.select().from(vaultDelegationGrants))[0].status).toBe('active');
  });

  it.each(['same-proposal', 'same-purpose'])('serializes concurrent %s executions to one grant and audit', async mode => {
    const first = await approval();
    const second = mode === 'same-proposal' ? first : await approval();
    const outcomes = await Promise.all([execute(first), execute(second)]);
    expect(outcomes.filter(result => result.ok)).toHaveLength(1);
    expect(await db.select().from(vaultDelegationGrants)).toHaveLength(1);
    expect(await db.select().from(vaultOwnerEnvelopes)).toHaveLength(1);
    expect(await db.select().from(attestations)).toHaveLength(1);
    expect(h.vault.entries).toHaveLength(1);
  });

  it.each(['wrong-subject', 'wrong-grantee', 'wrong-purpose', 'ambiguous'])('fetch fails closed for %s', async change => {
    expect(await execute(await approval())).toEqual({ ok: true });
    const [grant] = await db.select().from(vaultDelegationGrants);
    if (change === 'ambiguous') await db.insert(vaultDelegationGrants).values({ ...grant, id: 'second', field: 'different-field' });
    await expectCredentialUnavailable(fetchPurposeCredential(
      change === 'wrong-subject' ? HUMAN : ORG,
      change === 'wrong-grantee' ? HUMAN : h.nodeDid,
      change === 'wrong-purpose' ? 'other' : 'domain.issue',
    ));
  });

  it.each(['file', 'audit-insert', 'audit-sign', 'decrypt-provider', 'missing-audit-key'])('rolls back custody writes and sanitizes %s failures', async failure => {
    const card = await approval();
    if (failure === 'file') h.saveError = new Error(`provider rejected ${seed}`);
    if (failure === 'audit-sign') {
      const sign = crypto.signSync;
      vi.spyOn(crypto, 'signSync').mockImplementation((message, key) => {
        if (typeof message === 'string' && message.includes('"context_type":"vault.group-key"')) throw new Error(`provider rejected ${seed}`);
        return sign(message, key);
      });
    }
    if (failure === 'decrypt-provider') vi.spyOn(globalThis.crypto.subtle, 'decrypt').mockRejectedValueOnce(new Error(`provider decrypted ${seed}`));
    if (failure === 'missing-audit-key') vi.stubEnv('AUTH_PRIVATE_KEY', '');
    if (failure === 'audit-insert') {
      await client.exec(`CREATE FUNCTION auth.reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$;
        CREATE TRIGGER reject_audit BEFORE INSERT ON auth.attestations FOR EACH ROW EXECUTE FUNCTION auth.reject_audit();`);
    }
    try {
      await expectNoCustody(card);
    } finally {
      if (failure === 'audit-insert') await client.exec('DROP TRIGGER reject_audit ON auth.attestations; DROP FUNCTION auth.reject_audit();');
    }
  });

  it('sanitizes a seal provider exception containing plaintext before it can reach bridge logging', async () => {
    const card = await approval();
    vi.spyOn(vaultService, 'peek').mockRejectedValueOnce(new Error(`provider failed ${seed}`));
    await expectNoCustody(card);
  });

  it('rolls back revoke and erasure when its signed audit cannot be persisted', async () => {
    expect(await execute(await approval())).toEqual({ ok: true });
    const card = await approval('revoke-group-key');
    const before = await db.select().from(vaultDelegationGrants);
    await client.exec(`CREATE FUNCTION auth.reject_revoke_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$;
      CREATE TRIGGER reject_revoke_audit BEFORE INSERT ON auth.attestations FOR EACH ROW EXECUTE FUNCTION auth.reject_revoke_audit();`);
    try {
      expect(await execute(card)).toMatchObject({ ok: false });
      expect(await db.select().from(vaultDelegationGrants)).toEqual(before);
      expect(await db.select().from(attestations)).toHaveLength(1);
      expect(await fetchPurposeCredential(ORG, h.nodeDid, 'domain.issue') === seed).toBe(true);
    } finally {
      await client.exec('DROP TRIGGER reject_revoke_audit ON auth.attestations; DROP FUNCTION auth.reject_revoke_audit();');
    }
  });

  it('rejects unsigned revoke without touching the active grant and rejects replay after a signed revoke', async () => {
    expect(await execute(await approval())).toEqual({ ok: true });
    const card = await approval('revoke-group-key');
    const before = await db.select().from(vaultDelegationGrants);
    const unsigned = structuredClone(card);
    delete unsigned.decision!.operatorSignature;
    expect(await executeGroupKeyApproval(unsigned)).toMatchObject({ ok: false });
    expect(await db.select().from(vaultDelegationGrants)).toEqual(before);
    expect(await execute(card)).toEqual({ ok: true });
    expect(await execute(card)).toMatchObject({ ok: false });
    expect(await db.select().from(attestations)).toHaveLength(2);
    responses.push(await listGrantsForGrantee({ granteeDid: h.nodeDid }));
  });
});
