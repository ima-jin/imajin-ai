/**
 * Backlog re-address (#2723) over a real Postgres engine: pending connector
 * rows stored under the node operator move to their owner; decided, expired
 * and node-level rows never move; the whole thing is idempotent.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { CONNECTOR_OWNER_DID, OPERATOR_DID, githubProposalDetail } from './operator-approvals-test-helpers';
import { installConnectorInboxHarness, seedApproval } from './pglite-connector-inbox-harness';

const mocks = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('@/src/db', async () => {
  const { forwardingDb } = await import('./pglite-connector-inbox-harness');
  const { operatorApprovals } = await import('@/src/db/schemas/operator-approvals');
  return { db: forwardingDb(() => mocks.db), operatorApprovals };
});
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }) }));

import { readdressPendingConnectorApprovals } from '../approval-readdress';
import { operatorApprovals } from '@/src/db/schemas/operator-approvals';

const LESLEY_DID = 'did:imajin:lesley';
const NOW = new Date('2026-10-07T16:00:00.000Z');
const PAST = '2026-10-07T15:00:00.000Z';
const FUTURE = '2026-10-07T17:00:00.000Z';

const harness = installConnectorInboxHarness(mocks);

beforeEach(async () => {
  await harness.db.delete(operatorApprovals);
});

async function addressee(proposalId: string): Promise<string | undefined> {
  const [row] = await harness.db.select().from(operatorApprovals).where(eq(operatorApprovals.proposalId, proposalId));
  return row?.operatorDid;
}

/** The mixed backlog prod had: misrouted pending rows for two owners, plus every kind of row that must stay put. */
async function seedBacklog() {
  await seedApproval(harness.db, { proposalId: 'eric_pending_1' });
  await seedApproval(harness.db, { proposalId: 'eric_pending_2', kind: 'github:append' });
  await seedApproval(harness.db, { proposalId: 'lesley_pending', detail: githubProposalDetail(LESLEY_DID) });
  // Must NOT move:
  await seedApproval(harness.db, { proposalId: 'eric_approved', status: 'approved' });
  await seedApproval(harness.db, { proposalId: 'eric_denied', status: 'denied' });
  await seedApproval(harness.db, { proposalId: 'eric_applied', status: 'applied' });
  await seedApproval(harness.db, { proposalId: 'eric_withdrawn', status: 'withdrawn' });
  await seedApproval(harness.db, { proposalId: 'eric_expired', status: 'expired' });
  await seedApproval(harness.db, { proposalId: 'eric_past_expiry', detail: { ...githubProposalDetail(CONNECTOR_OWNER_DID), expiresAt: PAST } });
  await seedApproval(harness.db, { proposalId: 'operator_own', detail: githubProposalDetail(OPERATOR_DID) });
  await seedApproval(harness.db, { proposalId: 'gateway_restart', source: 'system-agent', kind: 'system-agent:restart', detail: null });
  await seedApproval(harness.db, { proposalId: 'apps_provision', source: 'apps', kind: 'apps:provision', detail: { slug: 'x', ownerDid: CONNECTOR_OWNER_DID } });
  await seedApproval(harness.db, { proposalId: 'already_owner', operatorDid: CONNECTOR_OWNER_DID });
}

const MOVED = ['eric_pending_1', 'eric_pending_2', 'lesley_pending'];
const UNTOUCHED = [
  ['eric_approved', OPERATOR_DID],
  ['eric_denied', OPERATOR_DID],
  ['eric_applied', OPERATOR_DID],
  ['eric_withdrawn', OPERATOR_DID],
  ['eric_expired', OPERATOR_DID],
  ['eric_past_expiry', OPERATOR_DID],
  ['operator_own', OPERATOR_DID],
  ['gateway_restart', OPERATOR_DID],
  ['apps_provision', OPERATOR_DID],
  ['already_owner', CONNECTOR_OWNER_DID],
] as const;

describe('readdressPendingConnectorApprovals (#2723)', () => {
  it('moves exactly the pending connector rows whose owner is not the operator, to their owner', async () => {
    await seedBacklog();

    const result = await readdressPendingConnectorApprovals({ now: NOW });

    expect(result.readdressed.map((row) => row.proposalId).sort()).toEqual([...MOVED].sort());
    expect(result.readdressed).toEqual(
      expect.arrayContaining([
        { proposalId: 'eric_pending_1', from: OPERATOR_DID, to: CONNECTOR_OWNER_DID },
        { proposalId: 'lesley_pending', from: OPERATOR_DID, to: LESLEY_DID },
      ]),
    );
    expect(await addressee('eric_pending_1')).toBe(CONNECTOR_OWNER_DID);
    expect(await addressee('eric_pending_2')).toBe(CONNECTOR_OWNER_DID);
    expect(await addressee('lesley_pending')).toBe(LESLEY_DID);
  });

  it.each(UNTOUCHED)('never touches %s (stays addressed to %s)', async (proposalId, expectedAddressee) => {
    await seedBacklog();
    const [before] = await harness.db.select().from(operatorApprovals).where(eq(operatorApprovals.proposalId, proposalId));

    await readdressPendingConnectorApprovals({ now: NOW });

    const [after] = await harness.db.select().from(operatorApprovals).where(eq(operatorApprovals.proposalId, proposalId));
    expect(after.operatorDid).toBe(expectedAddressee);
    expect(after).toEqual(before);
  });

  it('counts a pending row past its own detail.expiresAt as expired and skips it, but moves one still in date', async () => {
    await seedApproval(harness.db, { proposalId: 'in_date', detail: { ...githubProposalDetail(CONNECTOR_OWNER_DID), expiresAt: FUTURE } });
    await seedApproval(harness.db, { proposalId: 'lapsed', detail: { ...githubProposalDetail(CONNECTOR_OWNER_DID), expiresAt: PAST } });

    const result = await readdressPendingConnectorApprovals({ now: NOW });

    expect(result.skippedExpired).toBe(1);
    expect(result.readdressed.map((row) => row.proposalId)).toEqual(['in_date']);
    expect(await addressee('lapsed')).toBe(OPERATOR_DID);
  });

  it('is idempotent: a second run finds nothing to do and changes nothing', async () => {
    await seedBacklog();
    await readdressPendingConnectorApprovals({ now: NOW });
    const snapshot = await harness.db.select().from(operatorApprovals);

    const second = await readdressPendingConnectorApprovals({ now: NOW });

    expect(second.readdressed).toEqual([]);
    expect(second.scanned).toBe(1); // only the already-skipped past-expiry row still looks misrouted
    expect(second.skippedExpired).toBe(1);
    expect(await harness.db.select().from(operatorApprovals)).toEqual(snapshot);
  });

  it('dry run reports what it would move and writes nothing', async () => {
    await seedBacklog();
    const snapshot = await harness.db.select().from(operatorApprovals);

    const result = await readdressPendingConnectorApprovals({ now: NOW, dryRun: true });

    expect(result.readdressed.map((row) => row.proposalId).sort()).toEqual([...MOVED].sort());
    expect(await harness.db.select().from(operatorApprovals)).toEqual(snapshot);
  });

  it('leaves a row alone that was decided between the read and the write (guarded UPDATE)', async () => {
    await seedApproval(harness.db, { proposalId: 'raced' });
    const realUpdate = harness.db.update.bind(harness.db);
    // Simulate Eric deciding the proposal after the backlog read it but before it writes.
    const updateSpy = vi.spyOn(harness.db, 'update').mockImplementationOnce(((table: typeof operatorApprovals) => {
      // Drizzle builders are lazy thenables — `.then` is what actually dispatches the query, ahead of ours.
      void realUpdate(operatorApprovals).set({ status: 'approved' }).where(eq(operatorApprovals.proposalId, 'raced')).then(() => undefined);
      return realUpdate(table);
    }) as typeof harness.db.update);

    const result = await readdressPendingConnectorApprovals({ now: NOW });
    updateSpy.mockRestore();

    expect(result.readdressed).toEqual([]);
    expect(await addressee('raced')).toBe(OPERATOR_DID);
  });
});
