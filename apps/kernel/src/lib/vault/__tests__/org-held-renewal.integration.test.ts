import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes, createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { NextRequest } from 'next/server';
import type { Identity } from '@imajin/auth';
import type { VaultFile } from '@imajin/vault-core';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const h = vi.hoisted(() => ({
  db: null as unknown, identity: {} as Identity, vault: { version: 1, entries: [] } as VaultFile,
  log: vi.fn(), publish: vi.fn().mockResolvedValue(undefined), authError: false,
}));
vi.mock('@/src/db', async () => ({
  ...await import('@/src/db/schemas/auth'), ...await import('@/src/db/schemas/vault'),
  ...await import('@/src/db/schemas/connectors'), ...await import('@/src/db/schemas/operator-approvals'),
  get db() { return h.db; },
}));
vi.mock('@imajin/auth', async original => ({
  ...await original<typeof import('@imajin/auth')>(),
  requireAuth: vi.fn(async () => h.authError ? { error: 'Unauthorized', status: 401 } : { identity: h.identity }),
  requireAdmin: vi.fn().mockResolvedValue(true),
}));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ debug: h.log, info: h.log, warn: h.log, error: h.log }) }));
vi.mock('@imajin/bus', () => ({ publish: h.publish }));
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeDid: async () => 'did:imajin:node' }));
vi.mock('@/src/lib/notify/web-push', () => ({ pushWebNotificationToOperator: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../vault-repository', () => ({
  getVaultRepository: () => ({
    load: async () => structuredClone(h.vault),
    save: async (vault: VaultFile) => { h.vault = structuredClone(vault); },
  }),
}));

import { canonicalize, crypto, generateKeypair, requireAdmin, requireAuth } from '@imajin/auth';
import { pushWebNotificationToOperator } from '@/src/lib/notify/web-push';
import { identities, identityMembers, attestations } from '@/src/db/schemas/auth';
import { connectors, orgConnectionMemberGrants, orgConnectionSuspensions } from '@/src/db/schemas/connectors';
import { vaultDelegationGrants, vaultOwnerEnvelopes } from '@/src/db/schemas/vault';
import { operatorApprovals } from '@/src/db/schemas/operator-approvals';
import { POST } from '@/app/api/vault/org-held/renew/route';
import { POST as delegationGrant } from '@/app/api/vault/delegation/grant/route';
import { executeVaultApproval } from '../approvals-execution';
import { executeOrgHeldRenewal, readOrgHeldRenewalInput } from '../org-held-renewal';
import { decideOperatorApproval } from '@/src/lib/notify/operator-approvals-service';
import { sealAndGrantStaticSecret, canonicalizeGrantPayload, vaultService } from '../index';
import { getNodeSigningIdentity, _resetSealingCache } from '../sealing';
import { resolveOrgHeldBrain } from '@/src/lib/inference/org-held-brain';
import { DELEGATION_ROUTES } from '@imajin/auth/delegation-policy';

const keys = generateKeypair();
const nodeKeys = generateKeypair();
const tables = [identities, identityMembers, attestations, connectors, orgConnectionMemberGrants, orgConnectionSuspensions,
  vaultDelegationGrants, vaultOwnerEnvelopes, operatorApprovals];
let client: PGlite;
let database: ReturnType<typeof drizzle>;
let sequence = 0;
let human: string;
let org: string;
let field: string;
let value: string;
let oldExpiry: Date;
let outputs: unknown[];

function tableSql(table: PgTable) {
  const config = getTableConfig(table);
  const columns = config.columns.map(column => {
    let fallback = '';
    if (['created_at', 'updated_at', 'issued_at', 'granted_at'].includes(column.name)) fallback = ' DEFAULT now()';
    else if (typeof column.default === 'string') fallback = ` DEFAULT '${column.default}'`;
    else if (typeof column.default === 'boolean') fallback = ` DEFAULT ${column.default}`;
    else if (column.getSQLType() === 'jsonb' && column.default !== undefined) fallback = " DEFAULT '[]'::jsonb";
    return `"${column.name}" ${column.getSQLType()}${column.primary ? ' PRIMARY KEY' : ''}${column.notNull ? ' NOT NULL' : ''}${fallback}`;
  });
  return `CREATE TABLE "${config.schema}"."${config.name}" (${columns.join(',')})`;
}
beforeAll(async () => {
  client = new PGlite();
  await client.waitReady;
  await client.exec('CREATE SCHEMA auth; CREATE SCHEMA kernel; CREATE SCHEMA operator;');
  for (const table of tables) await client.exec(tableSql(table));
  await client.exec(`
    CREATE UNIQUE INDEX uniq_envelope ON kernel.vault_owner_envelopes(field,key_id);
    CREATE UNIQUE INDEX uniq_active ON kernel.vault_delegation_grants(subject,granted_to,field,key_id) WHERE status='active';
  `);
  database = drizzle(client);
  h.db = database;
});
afterAll(async () => { await client.close(); });
beforeEach(async () => {
  vi.clearAllMocks();
  h.publish.mockResolvedValue(undefined);
  vi.mocked(requireAdmin).mockResolvedValue(true);
  vi.mocked(pushWebNotificationToOperator).mockResolvedValue(undefined);
  vi.stubEnv('AUTH_PRIVATE_KEY', nodeKeys.privateKey);
  vi.stubEnv('VAULT_OWNER_X_PUB', '');
  vi.stubEnv('VAULT_OWNER_ED_PUB', '');
  vi.stubEnv('OPERATOR_COUNTERSIGN_REQUIRED', 'true');
  _resetSealingCache();
  sequence++;
  human = `did:imajin:human${sequence}`;
  org = `did:imajin:org${sequence}`;
  field = `external-mcp-key:org${sequence}:${org}`;
  value = randomBytes(32).toString('hex');
  outputs = [];
  oldExpiry = new Date(Date.now() + 60_000);
  h.authError = false;
  h.identity = { id: human, scope: 'actor', subtype: 'human', actingAs: org, actingAsRole: 'owner' };
  h.vault = { version: 1, entries: [] };
  await database.insert(identities).values([
    { id: human, scope: 'actor', subtype: 'human', publicKey: keys.publicKey },
    { id: org, scope: 'business', subtype: 'organization', publicKey: generateKeypair().publicKey },
  ]);
  await database.insert(identityMembers).values({ identityDid: org, memberDid: human, role: 'owner' });
  const node = getNodeSigningIdentity();
  await sealAndGrantStaticSecret(field, value, {
    principalDid: org, granteeDid: node.senderDid, purpose: 'connectors:org-held:anthropic', expiresAt: oldExpiry,
  });
  await database.insert(connectors).values({
    id: `conn_${sequence}`, ownerDid: org, provider: 'org-held-anthropic', channel: 'anthropic',
    connectorDid: node.senderDid, sealedKeyField: field, loadedByDid: human, loadedAt: new Date(),
  });
  await database.insert(orgConnectionMemberGrants).values({
    id: `member_grant_${sequence}`, orgDid: org, memberDid: human, connectionId: `conn_${sequence}`,
    provider: 'anthropic', grantedByDid: human,
  });
});
afterEach(async () => {
  expect(JSON.stringify([outputs, h.log.mock.calls, h.publish.mock.calls, h.vault])).not.toContain(value);
  vi.restoreAllMocks(); vi.unstubAllEnvs(); _resetSealingCache();
});
const later = () => new Date(Date.now() + 86400_000).toISOString();
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
async function grant() {
  return (await database.select().from(vaultDelegationGrants).where(eq(vaultDelegationGrants.subject, org)))[0];
}
async function propose(raw: unknown = { orgDid: org, provider: 'anthropic', expiresAt: later() }) {
  const response = await POST(new NextRequest('https://kernel.test/api/vault/org-held/renew', {
    method: 'POST', body: JSON.stringify(raw),
  }));
  const body = await response.json();
  outputs.push(body);
  return { status: response.status, body };
}
async function approve() {
  const proposed = await propose();
  expect(proposed.status).toBe(201);
  const [row] = await database.select().from(operatorApprovals).where(eq(operatorApprovals.proposalId, proposed.body.proposalId));
  const decidedAt = new Date().toISOString();
  const sig = crypto.signSync(canonicalize({ contentHash: row.contentHash!, decision: 'approve', decidedAt }), keys.privateKey);
  const result = await decideOperatorApproval({
    proposalId: row.proposalId, operatorDid: human, decision: 'approve', decidedAt,
    operatorSignature: { keyId: keys.publicKey, alg: 'ed25519', sig },
  });
  if (!result.ok) throw new Error(result.error);
  outputs.push(result.card);
  return result.card;
}
async function noChange(card: Awaited<ReturnType<typeof approve>>) {
  const before = await grant();
  const entry = structuredClone(h.vault);
  const result = await executeVaultApproval(card);
  outputs.push(result);
  expect(result.ok).toBe(false);
  expect(await grant()).toEqual(before);
  expect(h.vault).toEqual(entry);
  expect(await database.select().from(attestations).where(eq(attestations.subjectDid, org))).toEqual([]);
}
async function changeConnectionState(state: string) {
  const changes: Record<string, Partial<typeof connectors.$inferInsert>> = {
    'foreign-field': { sealedKeyField: 'vault-group-key:other' },
    'connection-off': { status: 'revoked' },
    'connection-suspended': { orgSuspendedAt: new Date() },
    'connection-expired': { expiresAt: new Date(0) },
  };
  if (changes[state]) await database.update(connectors).set(changes[state]).where(eq(connectors.ownerDid, org));
  if (state === 'entry-missing') vi.spyOn(vaultService, 'get').mockResolvedValue(undefined);
}

describe('private-custody org-held renewal acceptance', () => {
  it.each([false, true])('owner proposes in personal / acting-as-org=%s; signature extends custody without touching material', async actingAs => {
    if (!actingAs) h.identity = { id: human, scope: 'actor', subtype: 'human' };
    const before = await grant();
    const entry = structuredClone(h.vault);
    const envelope = await database.select().from(vaultOwnerEnvelopes).where(eq(vaultOwnerEnvelopes.field, field));
    const card = await approve();
    expect(await grant()).toEqual(before);
    expect(card.operatorDid).toBe(human);
    expect(card.detail?.orgDid).toBe(org);
    expect(requireAuth).toHaveBeenCalledWith(expect.any(NextRequest), { sessionOnly: true, service: 'connections' });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(oldExpiry.getTime() + 1000);
    await expect(resolveOrgHeldBrain({ orgDid: org, memberDid: human })).rejects.toMatchObject({ code: 'credential_unavailable' });
    clock.mockRestore();
    const get = vi.spyOn(vaultService, 'set');
    expect(await executeVaultApproval(card)).toEqual({ ok: true });
    const renewed = await grant();
    expect(renewed.expiresAt!.getTime()).toBeGreaterThan(oldExpiry.getTime());
    expect({ ...renewed, expiresAt: before.expiresAt, ownerSignature: before.ownerSignature }).toEqual(before);
    expect(h.vault).toEqual(entry);
    expect(get).not.toHaveBeenCalled();
    expect(await database.select().from(vaultOwnerEnvelopes).where(eq(vaultOwnerEnvelopes.field, field))).toEqual(envelope);
    vi.spyOn(Date, 'now').mockReturnValue(oldExpiry.getTime() + 1000);
    expect(renewed.expiresAt!.getTime()).toBeGreaterThan(Date.now());
    const brain = await resolveOrgHeldBrain({ orgDid: org, memberDid: human });
    expect(digest(brain.apiKey)).toBe(digest(value));
    expect(brain.credentialDid).toBe(org);
    const [audit] = await database.select().from(attestations).where(eq(attestations.subjectDid, org));
    expect(audit).toMatchObject({ type: 'vault.key.renewed', contextId: card.proposalId, attestationStatus: null });
    expect(audit.payload).toMatchObject({ orgDid: org, authorizedBy: { operatorDid: human } });
    expect(crypto.verifySync(audit.signature, canonicalize({
      subject_did: audit.subjectDid, type: audit.type, context_id: audit.contextId,
      context_type: audit.contextType, payload: audit.payload, issued_at: audit.issuedAt.getTime(),
    }), nodeKeys.publicKey)).toBe(true);
    await noReplay(card);
  });
  it('renews a lapsed but unswept grant without resupplying the provider key', async () => {
    const before = await grant();
    const expired = new Date(Date.now() - 1000);
    await database.update(vaultDelegationGrants).set({ expiresAt: expired,
      ownerSignature: crypto.signSync(canonicalizeGrantPayload({ ...before, expiresAt: expired }), nodeKeys.privateKey),
    }).where(eq(vaultDelegationGrants.id, before.id));
    expect(await executeVaultApproval(await approve())).toEqual({ ok: true });
    expect((await grant()).expiresAt!.getTime()).toBeGreaterThan(Date.now());
  });
  it('refuses unsigned renewal even with the global countersign requirement disabled', async () => {
    vi.stubEnv('OPERATOR_COUNTERSIGN_REQUIRED', 'false');
    const proposed = await propose();
    const decided = await decideOperatorApproval({ proposalId: proposed.body.proposalId, operatorDid: human, decision: 'approve' });
    expect(decided.ok).toBe(true);
    if (decided.ok) await noChange(decided.card);
  });
  it('refuses a different human decider at the decision rail', async () => {
    const proposed = await propose();
    expect(await decideOperatorApproval({ proposalId: proposed.body.proposalId, operatorDid: 'did:imajin:other', decision: 'approve' }))
      .toMatchObject({ ok: false, status: 403 });
  });
  it.each(['agent', 'presence'])('refuses %s even with an owner role in the database', async subtype => {
    await database.update(identities).set({ subtype }).where(eq(identities.id, human));
    expect((await propose()).status).toBe(403);
  });
  it.each(['member', 'removed', 'restricted', 'suspended', 'presence', 'no-key', 'tier1', 'human-suspended', 'key-changed'])('rechecks %s at execution', async boundary => {
    const card = await approve();
    if (boundary === 'member') await database.update(identityMembers).set({ role: 'member' }).where(eq(identityMembers.identityDid, org));
    if (boundary === 'removed') await database.update(identityMembers).set({ removedAt: new Date() }).where(eq(identityMembers.identityDid, org));
    if (boundary === 'restricted') await database.update(identityMembers).set({ allowedServices: ['pay'] }).where(eq(identityMembers.identityDid, org));
    if (boundary === 'suspended') await database.update(identities).set({ suspendedAt: new Date() }).where(eq(identities.id, org));
    if (boundary === 'presence') await database.update(identities).set({ subtype: 'presence' }).where(eq(identities.id, human));
    if (boundary === 'human-suspended') await database.update(identities).set({ suspendedAt: new Date() }).where(eq(identities.id, human));
    if (boundary === 'key-changed') await database.update(identities).set({ publicKey: generateKeypair().publicKey }).where(eq(identities.id, human));
    if (boundary === 'no-key') vi.stubEnv('AUTH_PRIVATE_KEY', '');
    if (boundary === 'tier1') { vi.stubEnv('VAULT_OWNER_X_PUB', keys.publicKey); vi.stubEnv('VAULT_OWNER_ED_PUB', keys.publicKey); }
    await noChange(card);
  });
  it.each(['unauthenticated', 'delegated', 'wrong-org', 'non-owner'])('refuses %s proposal', async boundary => {
    if (boundary === 'unauthenticated') h.authError = true;
    if (boundary === 'delegated') h.identity.actingFor = org;
    if (boundary === 'wrong-org') h.identity.actingAs = 'did:imajin:other';
    if (boundary === 'non-owner') await database.update(identityMembers).set({ role: 'member' }).where(eq(identityMembers.identityDid, org));
    const result = await propose();
    expect(result.status).toBe(boundary === 'unauthenticated' ? 401 : boundary === 'non-owner' ? 409 : 403);
    if (boundary === 'delegated') expect(result.body).toMatchObject({ code: 'AGENT_APPROVAL_REQUIRED', class: 'irreversible' });
  });
  it.each(['expiry', 'provider', 'org', 'extra', 'null', 'array'])('rejects invalid %s input', async failure => {
    const raw: Record<string, unknown> = { orgDid: org, provider: 'anthropic', expiresAt: later() };
    if (failure === 'expiry') raw.expiresAt = 'not-a-date';
    if (failure === 'provider') raw.provider = 'unknown';
    if (failure === 'org') raw.orgDid = 'not-a-did';
    if (failure === 'extra') raw.field = field;
    expect((await propose(failure === 'null' ? null : failure === 'array' ? [] : raw)).status).toBe(400);
  });
  it('rejects past expiry and invalid provider types', () => {
    expect(readOrgHeldRenewalInput({ orgDid: org, provider: 'anthropic', expiresAt: new Date(0).toISOString() })).toBeNull();
    expect(readOrgHeldRenewalInput({ orgDid: org, provider: 1, expiresAt: later() })).toBeNull();
    expect(DELEGATION_ROUTES['kernel.vault.org-held.renew'].class).toBe('irreversible');
  });
  it('rejects malformed JSON before staging a proposal', async () => {
    const response = await POST(new NextRequest('https://kernel.test/api/vault/org-held/renew', { method: 'POST', body: '{' }));
    expect(response.status).toBe(400);
  });
  it.each(['revoked', 'revoked-at', 'erased', 'one-time', 'purpose', 'foreign-signer', 'bad-signature', 'owner-x', 'recipient-x',
    'no-expiry', 'shorter', 'foreign-field', 'connection-off', 'connection-suspended', 'connection-expired', 'entry-missing'])(
    'refuses %s custody state without mutation', async failure => {
      const before = await grant();
      const changes: Record<string, unknown> = {};
      if (failure === 'revoked') changes.status = 'revoked';
      if (failure === 'revoked-at') changes.revokedAt = new Date();
      if (failure === 'erased') { changes.wrappedKey = ''; changes.wrappedNonce = ''; }
      if (failure === 'one-time') changes.oneTime = true;
      if (failure === 'purpose') changes.purpose = 'other';
      if (failure === 'foreign-signer') changes.ownerEdPub = keys.publicKey;
      if (failure === 'bad-signature') changes.ownerSignature = '00'.repeat(64);
      if (failure === 'owner-x') changes.ownerXPub = keys.publicKey;
      if (failure === 'recipient-x') changes.recipientXPub = keys.publicKey;
      if (failure === 'no-expiry') changes.expiresAt = null;
      if (failure === 'shorter') changes.expiresAt = new Date(Date.now() + 2 * 86400_000);
      if (Object.keys(changes).length) await database.update(vaultDelegationGrants).set(changes).where(eq(vaultDelegationGrants.id, before.id));
      await changeConnectionState(failure);
      const snapshot = await grant();
      expect((await propose()).status).toBe(409);
      expect(await grant()).toEqual(snapshot);
    });
  it.each(['detail', 'signature', 'stored-proposal', 'replaced-entry', 'swept', 'extra-detail', 'missing-detail',
    'bad-detail', 'past-expiry', 'wrong-kind', 'wrong-source', 'wrong-status', 'wrong-decider', 'wire-hash', 'no-signature'])('refuses %s drift after signing', async change => {
    const card = await approve();
    if (change === 'detail') card.detail!.expiresAt = new Date(Date.now() + 2 * 86400_000).toISOString();
    if (change === 'signature') card.decision!.operatorSignature!.sig = '00'.repeat(64);
    if (change === 'extra-detail') card.detail!.consumerDid = human;
    if (change === 'missing-detail') card.detail = null;
    if (change === 'bad-detail') card.detail!.grantId = 123;
    if (change === 'past-expiry') card.detail!.expiresAt = new Date(0).toISOString();
    if (change === 'wrong-kind') card.kind = 'vault:grant';
    if (change === 'wrong-source') card.source = 'other';
    if (change === 'wrong-status') card.status = 'denied';
    if (change === 'wrong-decider') card.decision!.decidedBy = org;
    if (change === 'wire-hash') card.decision!.contentHash = 'sha256:' + '00'.repeat(32);
    if (change === 'no-signature') delete card.decision!.operatorSignature;
    if (change === 'stored-proposal') await database.update(operatorApprovals).set({ summary: 'Changed' }).where(eq(operatorApprovals.proposalId, card.proposalId));
    if (change === 'replaced-entry') await sealAndGrantStaticSecret(field, randomBytes(32).toString('hex'), {
      principalDid: org, granteeDid: getNodeSigningIdentity().senderDid, purpose: 'connectors:org-held:anthropic', expiresAt: oldExpiry,
    });
    if (change === 'swept') await database.update(vaultDelegationGrants).set({ status: 'revoked', wrappedKey: '', wrappedNonce: '' })
      .where(eq(vaultDelegationGrants.id, (await grant()).id));
    await noChange(card);
  });
  it('serializes duplicate approved executions to a single renewal and audit', async () => {
    const card = await approve();
    const results = await Promise.all([executeOrgHeldRenewal(card), executeOrgHeldRenewal(card)]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(await database.select().from(attestations).where(eq(attestations.subjectDid, org))).toHaveLength(1);
  });
  it('rolls back renewal if the audit cannot be stored', async () => {
    const card = await approve();
    await client.exec(`CREATE FUNCTION auth.reject_renewal_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$;
      CREATE TRIGGER reject_renewal_audit BEFORE INSERT ON auth.attestations FOR EACH ROW EXECUTE FUNCTION auth.reject_renewal_audit();`);
    try { await noChange(card); } finally {
      await client.exec('DROP TRIGGER reject_renewal_audit ON auth.attestations; DROP FUNCTION auth.reject_renewal_audit();');
    }
  });
  it('keeps the delegation-grant private-custody 409 guard intact', async () => {
    const response = await delegationGrant(new NextRequest('https://kernel.test/api/vault/delegation/grant', {
      method: 'POST', body: JSON.stringify({
        ...await grant(), expiresAt: later(),
      }),
    }));
    expect(response.status).toBe(409);
    outputs.push(await response.json());
  });
});

async function noReplay(card: Awaited<ReturnType<typeof approve>>) {
  const before = await grant();
  expect(await executeVaultApproval(card)).toMatchObject({ ok: false });
  expect(await grant()).toEqual(before);
}
