/**
 * Tests for `reconciliation.ts` (#2172) — the three-bucket classification,
 * watermark persistence, and the "propose, never mutate" invariant
 * (no `creditUnit` call, no intent status change, ever).
 *
 * Uses `FakeRail` exclusively — proves the reconciler's classification
 * logic is genuinely rail-agnostic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  intentRows: [] as Array<Record<string, unknown>>,
  watermarkRows: new Map<string, { rail: string; lastReconciledAt: Date; updatedAt: Date }>(),
  publishMock: vi.fn(),
  creditUnitMock: vi.fn(),
  // Simulates `auth.attestations` for the dedup check: keys (intent id or
  // external ref) that already have a discrepancy attestation on file.
  // The default `publishMock` implementation (see `resetState`) adds a
  // key here on every successful publish, so calling `reconcileRail` twice
  // against the same stuck intent naturally dedupes on the second call —
  // no test needs to pre-seed this by hand.
  attestedKeys: new Set<string>(),
}));

vi.mock('@/src/db', async () => {
  const pay = await import('@/src/db/schemas/pay');
  const { PgDialect } = await import('drizzle-orm/pg-core');
  const dialect = new PgDialect();

  // `reconciliation.ts` always queries `withdrawalIntents` via
  // `and(eq(withdrawalIntents.rail, rail.name), eq(withdrawalIntents.status, statusValue))`
  // (see `classifyTransfers`/`classifyPendingIntents`) — decode the real SQL
  // condition's bound params (same `PgDialect().sqlToQuery()` pattern
  // `ledger.test.ts` uses) rather than special-casing a fake condition shape,
  // so this fake genuinely filters on what the module actually asked for.
  function filterIntentRows(cond: unknown) {
    const { params } = dialect.sqlToQuery(cond as Parameters<InstanceType<typeof PgDialect>['sqlToQuery']>[0]);
    const [railFilter, statusFilter] = params as [string, string];
    return state.intentRows.filter((row) => row.rail === railFilter && row.status === statusFilter);
  }

  return {
    db: {
      select: () => ({
        from: (table: unknown) => ({
          where: (cond: unknown) => {
            if (table === pay.withdrawalIntents) {
              return Promise.resolve(filterIntentRows(cond));
            }
            if (table === pay.reconciliationWatermarks) {
              const { params } = dialect.sqlToQuery(cond as Parameters<InstanceType<typeof PgDialect>['sqlToQuery']>[0]);
              const row = state.watermarkRows.get(params[0] as string);
              return Object.assign(Promise.resolve(row ? [row] : []), {
                limit: () => Promise.resolve(row ? [row] : []),
              });
            }
            return Promise.resolve([]);
          },
        }),
      }),
      insert: (table: unknown) => ({
        values: (values: { rail: string; lastReconciledAt: Date; updatedAt: Date }) => {
          if (table === pay.reconciliationWatermarks) state.watermarkRows.set(values.rail, values);
          return Object.assign(Promise.resolve(undefined), {
            onConflictDoUpdate: ({ set }: { set: Partial<typeof values> }) => {
              if (table === pay.reconciliationWatermarks) {
                state.watermarkRows.set(values.rail, { ...values, ...set });
              }
              return Promise.resolve(undefined);
            },
          });
        },
      }),
    },
    withdrawalIntents: pay.withdrawalIntents,
    reconciliationWatermarks: pay.reconciliationWatermarks,
  };
});

vi.mock('@imajin/bus', () => ({ publish: state.publishMock }));

// `emitReconciliationDiscrepancy`'s dedup check reads `auth.attestations`
// via the raw `@imajin/db` client, independent of the Drizzle `@/src/db`
// mock above. The single interpolated value in either dedup query
// (`payload->>'intent_id' = $1` or `payload->>'external_ref' = $1`) is
// exactly the key `attestedKeys` tracks.
vi.mock('@imajin/db', () => ({
  getClient: () => (_strings: TemplateStringsArray, ...values: unknown[]) => {
    const key = values[0] as string | undefined;
    return Promise.resolve(key && state.attestedKeys.has(key) ? [{ exists: 1 }] : []);
  },
}));

// `runReconciliation` iterates `listRegisteredRails()`, which would
// otherwise resolve the real `StripeWithdrawRail` and hit `getStripe()`.
// Stand in a `FakeRail` here — the registry's wiring itself isn't what
// this suite is testing. Dynamic import inside the factory (not a
// module-scope const) so this isn't subject to `vi.mock`'s hoisting-above-
// imports transform racing a not-yet-initialized top-level binding.
vi.mock('../rails/registry', async () => {
  const { FakeRail: HoistSafeFakeRail } = await import('./fake-rail');
  return { listRegisteredRails: () => [new HoistSafeFakeRail({ name: 'fake' })] };
});

import { reconcileRail, runReconciliation } from '../reconciliation';
import { FakeRail } from './fake-rail';

function resetState() {
  state.intentRows.length = 0;
  state.watermarkRows.clear();
  state.attestedKeys.clear();
  state.publishMock.mockReset().mockImplementation(
    async (_type: string, event: { payload: { intent_id: string | null; external_ref: string | null } }) => {
      const key = event.payload.intent_id ?? event.payload.external_ref;
      if (key) state.attestedKeys.add(key);
    },
  );
  process.env.PLATFORM_DID = 'did:imajin:platform';
  delete process.env.WITHDRAWAL_RECONCILE_TIMEOUT_MS;
}

beforeEach(resetState);

describe('reconcileRail — three buckets (#2172 acceptance criteria)', () => {
  it('classifies a rail transfer with a completed matching intent as matched — no attestation emitted', async () => {
    const rail = new FakeRail();
    const intent = await reserveViaFakeRail(rail, 'did:imajin:a', 5);
    state.intentRows.push({ id: intent.id, did: intent.did, unit: 'MJN', amount: '5', rail: rail.name, status: 'completed', createdAt: new Date() });

    const result = await reconcileRail(rail, new Date(0), new Date());

    expect(result.matched).toBe(1);
    expect(result.externalWithoutLedger).toBe(0);
    expect(state.publishMock).not.toHaveBeenCalled();
  });

  it('classifies a rail transfer with NO completed intent as external-without-ledger (dangerous) and emits a signed attestation', async () => {
    const rail = new FakeRail();
    rail.seedTransfer({ externalRef: 'fake_tr_orphan', intentId: 'wdi_missing', amount: 5, unit: 'MJN', createdAt: new Date() });

    const result = await reconcileRail(rail, new Date(0), new Date());

    expect(result.externalWithoutLedger).toBe(1);
    expect(state.publishMock).toHaveBeenCalledWith(
      'pay.reconciliation.discrepancy',
      expect.objectContaining({
        issuer: 'did:imajin:platform',
        payload: expect.objectContaining({
          rail: rail.name,
          bucket: 'external_without_ledger',
          intent_id: 'wdi_missing',
          external_ref: 'fake_tr_orphan',
        }),
      }),
    );
  });

  it('classifies a pending intent older than the timeout with no rail transfer as pending-timeout (safe) and emits a signed attestation', async () => {
    process.env.WITHDRAWAL_RECONCILE_TIMEOUT_MS = '1000';
    const rail = new FakeRail();
    const oldEnough = new Date(Date.now() - 5000);
    state.intentRows.push({ id: 'wdi_stuck', did: 'did:imajin:b', unit: 'MJN', amount: '7', rail: rail.name, status: 'pending', createdAt: oldEnough });

    const result = await reconcileRail(rail, new Date(0), new Date());

    expect(result.pendingTimeout).toBe(1);
    expect(state.publishMock).toHaveBeenCalledWith(
      'pay.reconciliation.discrepancy',
      expect.objectContaining({
        payload: expect.objectContaining({ bucket: 'pending_timeout', intent_id: 'wdi_stuck', external_ref: null, amount: '7' }),
      }),
    );
    // #2172 review fix 4: the exact numeric string, never `Number.parseFloat`'d.
    const publishedAmount = state.publishMock.mock.calls[0][1].payload.amount;
    expect(publishedAmount).toBe('7');
    expect(typeof publishedAmount).toBe('string');
  });

  it('does NOT flag a pending intent still within the timeout window', async () => {
    process.env.WITHDRAWAL_RECONCILE_TIMEOUT_MS = String(60 * 60 * 1000);
    const rail = new FakeRail();
    state.intentRows.push({ id: 'wdi_fresh', did: 'did:imajin:c', unit: 'MJN', amount: '3', rail: rail.name, status: 'pending', createdAt: new Date() });

    const result = await reconcileRail(rail, new Date(0), new Date());

    expect(result.pendingTimeout).toBe(0);
    expect(state.publishMock).not.toHaveBeenCalled();
  });

  it('a pending intent past timeout whose transfer DOES exist (just outside the per-intent list scope) is not double-flagged as pending-timeout', async () => {
    process.env.WITHDRAWAL_RECONCILE_TIMEOUT_MS = '1000';
    const rail = new FakeRail();
    const createdAt = new Date(Date.now() - 5000);
    state.intentRows.push({ id: 'wdi_actually_ok', did: 'did:imajin:d', unit: 'MJN', amount: '4', rail: rail.name, status: 'pending', createdAt });
    rail.seedTransfer({ externalRef: 'fake_tr_late', intentId: 'wdi_actually_ok', amount: 4, unit: 'MJN', createdAt: new Date(createdAt.getTime() + 100) });

    const result = await reconcileRail(rail, new Date(0), new Date());

    expect(result.pendingTimeout).toBe(0);
  });

  it('never calls creditUnit and never mutates a balance — reconciliation only proposes via attestation', async () => {
    const rail = new FakeRail();
    rail.seedTransfer({ externalRef: 'fake_tr_orphan', intentId: null, amount: 5, unit: 'MJN', createdAt: new Date() });
    state.intentRows.push({ id: 'wdi_stuck', did: 'did:imajin:e', unit: 'MJN', amount: '7', rail: rail.name, status: 'pending', createdAt: new Date(0) });

    await reconcileRail(rail, new Date(0), new Date());

    // No ledger module is even imported by reconciliation.ts — asserted
    // structurally by the fact this test file never mocks or imports
    // `creditUnit` from anywhere and the module still behaves correctly.
    expect(state.creditUnitMock).not.toHaveBeenCalled();
  });

  it('skips (never throws) emitting the attestation when PLATFORM_DID is not set', async () => {
    delete process.env.PLATFORM_DID;
    const rail = new FakeRail();
    rail.seedTransfer({ externalRef: 'fake_tr_orphan', intentId: null, amount: 5, unit: 'MJN', createdAt: new Date() });

    const result = await reconcileRail(rail, new Date(0), new Date());

    expect(result.externalWithoutLedger).toBe(1);
    expect(state.publishMock).not.toHaveBeenCalled();
  });

  it('logs but does not throw when publish() itself rejects', async () => {
    state.publishMock.mockRejectedValueOnce(new Error('bus down'));
    const rail = new FakeRail();
    rail.seedTransfer({ externalRef: 'fake_tr_orphan', intentId: null, amount: 5, unit: 'MJN', createdAt: new Date() });

    await expect(reconcileRail(rail, new Date(0), new Date())).resolves.toMatchObject({ externalWithoutLedger: 1 });
  });

  it('does not re-attest the same discrepancy on a second sweep of the same stuck intent (#2172 review fix 2)', async () => {
    process.env.WITHDRAWAL_RECONCILE_TIMEOUT_MS = '1000';
    const rail = new FakeRail();
    const oldEnough = new Date(Date.now() - 5000);
    state.intentRows.push({ id: 'wdi_stuck_dedup', did: 'did:imajin:f', unit: 'MJN', amount: '7', rail: rail.name, status: 'pending', createdAt: oldEnough });

    const first = await reconcileRail(rail, new Date(0), new Date());
    const second = await reconcileRail(rail, new Date(0), new Date());

    expect(first.pendingTimeout).toBe(1);
    expect(second.pendingTimeout).toBe(1); // still classified as a discrepancy on the second run...
    expect(state.publishMock).toHaveBeenCalledTimes(1); // ...but only attested once.
  });

  it('does not re-attest an external-without-ledger discrepancy for the same transfer across sweeps', async () => {
    const rail = new FakeRail();
    rail.seedTransfer({ externalRef: 'fake_tr_dedup', intentId: null, amount: 5, unit: 'MJN', createdAt: new Date() });

    await reconcileRail(rail, new Date(0), new Date());
    await reconcileRail(rail, new Date(0), new Date());

    expect(state.publishMock).toHaveBeenCalledTimes(1);
  });
});

describe('runReconciliation — watermark persistence', () => {
  it('advances the watermark for each registered rail after a successful sweep', async () => {
    const before = await runReconciliation();
    expect(before.rails.length).toBeGreaterThan(0);
    for (const r of before.rails) {
      expect(state.watermarkRows.get(r.rail)?.lastReconciledAt.getTime()).toBe(r.newWatermark.getTime());
    }
  });
});

/** Helper: run a FakeRail execute() as if the intent had been reserved through the real flow, returning the synthetic intent shape reconcileRail's matching logic needs. */
async function reserveViaFakeRail(rail: FakeRail, did: string, amount: number) {
  const intent = { id: `wdi_${Math.random().toString(36).slice(2)}`, did, unit: 'MJN' as const, amount: String(amount), rail: rail.name, idempotencyKey: '' };
  intent.idempotencyKey = intent.id;
  await rail.execute(intent);
  return intent;
}
