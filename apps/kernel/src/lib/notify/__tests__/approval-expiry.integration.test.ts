import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { canonicalize, crypto, ATTESTATION_TYPES, MECHANICAL_ATTESTATION_TYPES } from '@imajin/auth';
import { installConnectorInboxHarness, seedApproval, forwardingDb } from './pglite-connector-inbox-harness';
import { OPERATOR_DID, CONNECTOR_OWNER_DID, githubProposalDetail } from './operator-approvals-test-helpers';

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/src/db', async () => {
  const { operatorApprovals } = await import('@/src/db/schemas/operator-approvals');
  const { attestations } = await import('@/src/db/schemas/auth');
  return { db: forwardingDb(() => state.db), operatorApprovals, attestations, identities: {} };
});
vi.mock('@/src/lib/kernel/node-identity', () => ({
  getNodeDid: async () => 'did:imajin:test-node',
  getNodeSelfInfo: async () => ({ nodeOperatorDid: OPERATOR_DID }),
}));
vi.mock('@imajin/bus', () => ({ publish: vi.fn() }));
vi.mock('@/src/lib/notify/web-push', () => ({ pushWebNotificationToOperator: vi.fn() }));
vi.mock('@/src/lib/vault/sealing', () => ({ getNodeSigningIdentity: vi.fn() }));

import { operatorApprovals } from '@/src/db/schemas/operator-approvals';
import { expireApprovals, expireApproval, reportApprovalSourceState } from '../approval-expiry';
import { countInboxApprovals } from '../approval-inbox-count';
import { listApprovalsForOperator, markApplied, decideOperatorApproval, archiveOperatorApproval, attachApprovalOutcome } from '../operator-approvals-service';

const harness = installConnectorInboxHarness(state);
const keys = crypto.generateKeypair();
const now = Date.now();
const old = new Date(now - 8 * 86_400_000);

beforeAll(async () => {
  await harness.db.execute(sql.raw('CREATE SCHEMA auth'));
  await harness.db.execute(sql.raw(`CREATE TABLE auth.attestations (
    id text PRIMARY KEY, issuer_did text, subject_did text, type text, context_id text, context_type text,
    payload jsonb, signature text NOT NULL, cid text, attestation_status text, issued_at timestamptz,
    nostr_sig text, author_jws text, witness_jws text, document_hash text, document_asset_id text,
    total_signers integer, delegator_did text, disclosure_scope jsonb, prev_event_ref text,
    delegation_grant_id text, supersedes text, ref text, expires_at timestamptz,
    revoked_at timestamptz, lapsed_at timestamptz
  )`));
});
beforeEach(async () => {
  vi.stubEnv('AUTH_PRIVATE_KEY', keys.privateKey);
  vi.stubEnv('OPERATOR_APPROVAL_EXPIRY_DAYS', '7');
  await harness.db.execute(sql.raw('TRUNCATE operator.approvals, auth.attestations'));
});
afterEach(() => { vi.unstubAllEnvs(); });

async function seed(id: string, change: Partial<typeof operatorApprovals.$inferInsert> = {}) {
  await seedApproval(harness.db, { proposalId: id, source: 'system-agent', kind: 'system-agent:restart', detail: null, createdAt: old, ...change });
}
async function row(id: string) {
  const [result] = await harness.db.select().from(operatorApprovals).where(eq(operatorApprovals.proposalId, id));
  return result;
}
async function evidence() {
  return harness.db.execute<{ id: string; payload: Record<string, unknown>; signature: string; issued_at: Date; subject_did: string }>(
    sql`select * from auth.attestations`,
  );
}

describe('signed approval expiry and retained history (#3016)', () => {
  it('sweeps legacy pending and approved/unapplied rows once, preserving every signed decision and archive marker', async () => {
    const decision = { payload: { decision: 'approve' }, signature: 'original-decision' };
    const outcome = { metadata: 'keep', inboxArchivedBy: { [OPERATOR_DID]: old.toISOString() } };
    await seed('pending');
    await seed('approved', { status: 'approved', decision, outcome });
    await seed('fresh', { createdAt: new Date() });
    await seed('applied', { status: 'applied', appliedAt: new Date() });
    await seed('denied', { status: 'denied' });
    expect(await expireApprovals(now)).toBe(2);
    expect(await expireApprovals(now)).toBe(0);
    expect((await row('approved')).decision).toEqual(decision);
    expect((await row('approved')).outcome).toMatchObject(outcome);
    const records = await evidence();
    expect(records.rows).toHaveLength(2);
    for (const event of records.rows) {
      expect(event.payload.reason).toMatch(/deadline/);
      expect(crypto.verifySync(event.signature, canonicalize({
        subject_did: event.subject_did, type: 'operator.approval.expired',
        context_id: event.payload.proposalId, context_type: 'operator.approval',
        payload: event.payload, issued_at: new Date(event.issued_at).getTime(),
      }), keys.publicKey)).toBe(true);
    }
    expect(ATTESTATION_TYPES).toContain('operator.approval.expired');
    expect(MECHANICAL_ATTESTATION_TYPES).toContain('operator.approval.expired');
    expect((await listApprovalsForOperator(OPERATOR_DID, { includeHistory: false })).map(card => card.proposalId)).toEqual(['fresh']);
    expect(await listApprovalsForOperator(OPERATOR_DID)).toHaveLength(5);
    expect(await countInboxApprovals(OPERATOR_DID)).toEqual({ pending: 1, total: 5 });
  });

  it('uses source deadlines, fallback N, and signed source-gone/superseded reports', async () => {
    await seed('source-deadline', { status: 'approved', createdAt: new Date(), detail: { expiresAt: old.toISOString() } });
    await seed('future-deadline', { status: 'approved', detail: { expiresAt: new Date(now + 86_400_000).toISOString() } });
    await seed('configured', { createdAt: new Date(now - 3 * 86_400_000) });
    vi.stubEnv('OPERATOR_APPROVAL_EXPIRY_DAYS', '2');
    expect(await expireApprovals(now)).toBe(2);
    for (const sourceState of ['gone', 'superseded'] as const) {
      await seed(sourceState, { createdAt: new Date() });
      expect(await reportApprovalSourceState(sourceState, sourceState)).toBe(true);
      expect(await reportApprovalSourceState(sourceState, sourceState)).toBe(true);
      expect((await row(sourceState)).outcome?.approvalExpiry).toMatchObject({ reason: `source reports ${sourceState}` });
    }
    expect(await reportApprovalSourceState('missing', 'gone')).toBe(false);
    expect((await row('future-deadline')).status).toBe('approved');
  });

  it('refuses expired and overdue decisions, without signing, and keeps ownership boundaries', async () => {
    await seed('expired', { status: 'expired' });
    await seed('overdue');
    for (const proposalId of ['expired', 'overdue']) {
      const result = await decideOperatorApproval({ proposalId, operatorDid: OPERATOR_DID, decision: 'approve' });
      expect(result).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/expired/) });
      expect(await decideOperatorApproval({ proposalId, operatorDid: CONNECTOR_OWNER_DID, decision: 'approve' })).toMatchObject({ ok: false, status: 403 });
    }
    expect((await evidence()).rows).toHaveLength(0);
  });

  it('accepts late markApplied only for an expired previously approved card and retains the expiry record', async () => {
    await seed('late', { status: 'approved' });
    await seed('never-approved');
    await expireApprovals(now);
    expect(await markApplied('late')).toEqual({ ok: true });
    expect(await markApplied('late')).toEqual({ ok: true });
    expect(await markApplied('never-approved')).toEqual({ ok: false });
    expect((await row('late')).status).toBe('applied');
    expect((await row('late')).appliedAt).toBeInstanceOf(Date);
    expect((await row('late')).outcome?.approvalExpiry).toBeDefined();
    expect((await evidence()).rows).toHaveLength(2);
  });

  it('fails closed on signing or evidence insert failure and loses CAS races without duplicate attestations', async () => {
    await seed('race');
    const stale = await row('race');
    vi.stubEnv('AUTH_PRIVATE_KEY', '');
    await expect(expireApproval(stale, 'test reason')).rejects.toThrow();
    expect((await row('race')).status).toBe('pending');
    vi.stubEnv('AUTH_PRIVATE_KEY', keys.privateKey);
    await harness.db.execute(sql.raw("ALTER TABLE auth.attestations ADD CONSTRAINT reject_evidence CHECK (type != 'operator.approval.expired')"));
    await expect(expireApproval(stale, 'test reason')).rejects.toThrow();
    expect((await row('race')).status).toBe('pending');
    await harness.db.execute(sql.raw('ALTER TABLE auth.attestations DROP CONSTRAINT reject_evidence'));
    expect(await expireApproval(stale, 'test reason')).toBe(true);
    expect(await expireApproval(stale, 'test reason')).toBe(false);
    expect((await evidence()).rows).toHaveLength(1);
    expect(await expireApproval(await row('race'), 'test reason')).toBe(false);
  });

  it('generalizes archive markers across sources and preserves them when execution outcomes arrive', async () => {
    await seed('exec', { source: 'gateway-exec', kind: 'gateway-exec:command', status: 'approved', createdAt: new Date() });
    expect(await archiveOperatorApproval({ proposalId: 'exec', operatorDid: CONNECTOR_OWNER_DID })).toMatchObject({ ok: false, status: 403 });
    expect(await archiveOperatorApproval({ proposalId: 'exec', operatorDid: OPERATOR_DID })).toEqual({ ok: true });
    await attachApprovalOutcome('exec', { exitCode: 0, durationMs: 5, outputHash: 'test-hash' });
    const [card] = await listApprovalsForOperator(OPERATOR_DID);
    expect(card.archivedAt).toBeTruthy();
    expect(card.outcome).toMatchObject({ exitCode: 0 });
    expect(card.outcome).not.toHaveProperty('inboxArchivedBy');
    expect((await row('exec')).status).toBe('applied');
    expect(await countInboxApprovals(OPERATOR_DID)).toEqual({ pending: 0, total: 1 });
  });

  it('shares the exact list/count predicate in personal, connector and acting projections', async () => {
    const changes = [
      { status: 'pending', createdAt: new Date() }, { status: 'approved', createdAt: new Date() },
      { status: 'pending' }, { status: 'approved' }, { status: 'denied' }, { status: 'applied' },
      { status: 'pending', createdAt: new Date(), detail: { expiresAt: old.toISOString() } },
      { status: 'approved', createdAt: new Date(), decision: { sessionCommand: { commandId: 'native' } } },
      { status: 'approved', createdAt: new Date(), outcome: { inboxArchivedBy: { [OPERATOR_DID]: old.toISOString() } } },
    ];
    for (const [index, change] of changes.entries()) await seed(`personal-${index}`, change);
    await seed('connector', { source: 'github', kind: 'github:mutate', detail: githubProposalDetail(CONNECTOR_OWNER_DID), createdAt: new Date() });
    await seed('org-reach', { operatorDid: 'did:imajin:test-org', source: 'reach', kind: 'reach:message', createdAt: new Date() });
    for (const did of [OPERATOR_DID, CONNECTOR_OWNER_DID, 'did:imajin:test-org']) {
      const cards = await listApprovalsForOperator(did, { includeHistory: false });
      expect((await countInboxApprovals(did)).pending).toBe(cards.length);
    }
    const personal = await listApprovalsForOperator(OPERATOR_DID, { includeHistory: false });
    const org = await listApprovalsForOperator('did:imajin:test-org', { includeHistory: false });
    expect((await countInboxApprovals(OPERATOR_DID, { sharedReachPrincipal: 'did:imajin:test-org' })).pending).toBe(personal.length + org.length);
  });
});
