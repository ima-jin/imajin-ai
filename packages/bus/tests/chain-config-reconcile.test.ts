import { describe, it, expect, vi, beforeAll } from 'vitest';

// Force chain-config lookups to miss the DB so getChainConfig() falls back to
// the hardcoded DEFAULTS map. This lets us assert the reconciled chains
// deterministically without a live kernel.bus_chain_configs table.
vi.mock('@imajin/db', () => ({
  getClient: () => () => Promise.resolve([]),
}));

import { getChainConfig } from '../src/config';

describe('chain config DEFAULTS reconcile (#1873, #1874)', () => {
  it('order.completed includes supply-recorder before settle (#1873)', async () => {
    const cfg = await getChainConfig('order.completed', 'supply');
    const types = cfg.reactors.map((r) => r.type);

    expect(types).toEqual(['supply-recorder', 'settle']);
    expect(cfg.reactors[0]?.await).toBe(true);
    expect(cfg.reactors[1]?.await).toBe(true);
  });

  it('attestation.created includes attestation-notify after emit (#1856, #1874)', async () => {
    const cfg = await getChainConfig('attestation.created', 'default');
    const types = cfg.reactors.map((r) => r.type);

    expect(types).toEqual(['emit', 'attestation-notify']);
    expect(cfg.reactors.every((r) => r.enabled)).toBe(true);
  });

  it('availability.match.surfaced includes notify-match-delivery after emit (#1874)', async () => {
    const cfg = await getChainConfig('availability.match.surfaced', 'default');
    const types = cfg.reactors.map((r) => r.type);

    expect(types).toEqual(['emit', 'notify-match-delivery']);
    expect(cfg.reactors.every((r) => r.enabled)).toBe(true);
  });

  it('usage.incurred routes to attestation + emit with NO settle reactor (#1147/#1148)', async () => {
    const cfg = await getChainConfig('usage.incurred', 'default');
    const types = cfg.reactors.map((r) => r.type);

    expect(types).toEqual(['attestation', 'emit']);
    expect(types).not.toContain('settle');
    expect(cfg.reactors.every((r) => r.enabled)).toBe(true);
  });

  it('usage.rollup routes to attestation (awaited) + emit with NO settle reactor (#1148)', async () => {
    const cfg = await getChainConfig('usage.rollup', 'default');
    const types = cfg.reactors.map((r) => r.type);

    expect(types).toEqual(['attestation', 'emit']);
    expect(types).not.toContain('settle');
    expect(cfg.reactors[0]?.await).toBe(true);
  });

  it.each([
    'payment_request.issued',
    'payment_request.paid',
    'payment_request.settled',
    'payment_request.voided',
    'payment_request.recipient_claimed',
  ])('%s routes to payment-request-notify (#2212)', async (eventType) => {
    const cfg = await getChainConfig(eventType, 'default');
    const types = cfg.reactors.map((r) => r.type);

    expect(types).toEqual(['payment-request-notify']);
    expect(cfg.reactors.every((r) => r.enabled)).toBe(true);
  });

  it('payment_request.settlement_failed emits and notifies the operator with the retry path (#2439)', async () => {
    const cfg = await getChainConfig('payment_request.settlement_failed', 'default');
    const types = cfg.reactors.map((r) => r.type);

    expect(types).toEqual(['emit', 'notify']);
    expect(cfg.reactors.every((r) => r.enabled)).toBe(true);
    const notify = cfg.reactors.find((r) => r.type === 'notify');
    // No `to` override: the event's subject (the operator/node DID) is the recipient.
    expect(notify?.config.to).toBeUndefined();
    expect(notify?.config.title).toContain('{{reason}}');
    expect(notify?.config.body).toContain('{{paymentRequestId}}');
    expect(notify?.config.body).toContain('/pay/api/admin/payment-requests/{{paymentRequestId}}/retry-settlement');
  });

  it('vault.delegation.fetched routes to audit-log (#2231)', async () => {
    const cfg = await getChainConfig('vault.delegation.fetched', 'default');
    const types = cfg.reactors.map((r) => r.type);

    expect(types).toEqual(['audit-log']);
    expect(cfg.reactors.every((r) => r.enabled)).toBe(true);
  });

  it('vault.delegation.acked routes to audit-log (#2235)', async () => {
    const cfg = await getChainConfig('vault.delegation.acked', 'default');
    const types = cfg.reactors.map((r) => r.type);

    expect(types).toEqual(['audit-log']);
    expect(cfg.reactors.every((r) => r.enabled)).toBe(true);
  });

  it.each(['vault.key.minted', 'vault.key.revoked'])('%s routes to audit-log (#2242)', async (eventType) => {
    const cfg = await getChainConfig(eventType, 'default');
    const types = cfg.reactors.map((r) => r.type);

    expect(types).toEqual(['audit-log']);
    expect(cfg.reactors.every((r) => r.enabled)).toBe(true);
  });

  // #2263 audit (follow-up to #2251/#2255): pins the exact audit-log
  // `fields` allowlist for agent.reach events — disclosure-safe principal
  // refs + outcome only, never the transcript, the requester's raw
  // signature, or the gate's predicate/arg internals (same posture as
  // vault.delegation.fetched/vault.key.minted above). Kept in sync with
  // migration 0151; see tests/audit-log.test.ts for the reactor-level
  // exact-key-set assertion this config feeds.
  it('agent.reach.answered routes to audit-log with the disclosure-safe field allowlist (#2263)', async () => {
    const cfg = await getChainConfig('agent.reach.answered', 'default');

    expect(cfg.reactors).toEqual([
      {
        type: 'audit-log',
        config: { fields: ['requesterDid', 'principalDid', 'onBehalfOfStubDid', 'purpose', 'field', 'answer', 'grantId'] },
        enabled: true,
      },
    ]);
  });

  it('agent.reach.denied routes to audit-log with the disclosure-safe field allowlist (#2263)', async () => {
    const cfg = await getChainConfig('agent.reach.denied', 'default');

    expect(cfg.reactors).toEqual([
      { type: 'audit-log', config: { fields: ['requesterDid', 'principalDid', 'reason'] }, enabled: true },
    ]);
  });

  it.each([
    'access.knock.requested',
    'access.bearer.issued',
    'access.bearer.used',
    'access.bearer.denied',
    'access.bearer.revoked',
  ])('%s routes to audit-log (#2252)', async (eventType) => {
    const cfg = await getChainConfig(eventType, 'default');
    const types = cfg.reactors.map((r) => r.type);

    expect(types).toEqual(['audit-log']);
    expect(cfg.reactors.every((r) => r.enabled)).toBe(true);
  });
});

describe('apps.signing-key.claimed chain (#2444)', () => {
  it('mints an awaited attestation so publish() can return its id to POST /api/apps/claim', async () => {
    const cfg = await getChainConfig('apps.signing-key.claimed', 'apps');

    expect(cfg.reactors).toEqual([
      { type: 'attestation', config: { attestationType: 'apps.signing-key.claimed' }, await: true, enabled: true },
    ]);
  });
});

// The bus barrel (`../src/index`) transitively loads the broker, every reactor
// and the notify/emit/logger stack. Imported cold inside an `it()` it ate the
// whole 5s testTimeout on a loaded CI runner (#2616) although it takes well
// under a second on an idle one. This is a cold-import cost, not a hang, so pay
// it once in a hook with an explicit budget instead of inside a test body.
const BARREL_IMPORT_TIMEOUT_MS = 60_000;

const loadBus = () => import('../src/index');

describe('broker reactor registry (#1874)', () => {
  let bus: Awaited<ReturnType<typeof loadBus>>;

  beforeAll(async () => {
    bus = await loadBus();
  }, BARREL_IMPORT_TIMEOUT_MS);

  it('mutual-reach-consent reactor is exported from the bus package', () => {
    expect(typeof bus.mutualReachConsentReactor).toBe('function');
  });

  it('intersection-scope reactor is exported from the bus package', () => {
    expect(typeof bus.intersectionScopeReactor).toBe('function');
  });
});
