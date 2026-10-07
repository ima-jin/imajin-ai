/**
 * publishAppEvent() — the app-origin publish path (#2638 / #2641, ruled "b").
 *
 * The fake DB serves `kernel.bus_chain_configs` rows, so these tests prove the
 * ceiling against money-moving chains an operator could configure for scope `apps`:
 * `listing.purchased` = attestation + mjn + settle + notify and
 * `tip.granted` = attestation + mjn + notify. Only notify and audit-log may run.
 * The chain is resolved from scope `apps` ONLY (#2717): the node-default row and
 * the hardcoded DEFAULTS are never consulted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

type Row = { reactors: Array<{ type: string; config: Record<string, unknown>; enabled: boolean }>; enabled: boolean };

/** `kernel.bus_chain_configs` rows keyed `<event_type>|<scope or null>`. */
const { chainRows, fakeSql } = vi.hoisted(() => {
  const chainRows = new Map<string, Row>();
  // The scoped query binds (event_type, scope); the node-default query binds (event_type) only.
  const fakeSql = (_strings: TemplateStringsArray, ...values: unknown[]) => {
    const row = chainRows.get(`${values[0]}|${values.length > 1 ? values[1] : null}`);
    return Promise.resolve(row ? [row] : []);
  };
  return { chainRows, fakeSql };
});
vi.mock('@imajin/db', () => ({ getClient: () => fakeSql }));

const { handlers } = vi.hoisted(() => ({
  handlers: {
    attestation: vi.fn().mockResolvedValue(undefined),
    mjn: vi.fn().mockResolvedValue(undefined),
    settle: vi.fn().mockResolvedValue(undefined),
    emit: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn().mockResolvedValue(undefined),
    'audit-log': vi.fn().mockResolvedValue(undefined),
  } as Record<string, ReturnType<typeof vi.fn>>,
}));
vi.mock('../src/registry', () => ({
  getReactor: (type: string) => handlers[type],
}));

import type { publishAppEvent as PublishAppEvent } from '../src/publish-app-event';
import { APP_EVENT_REACTORS, APP_EVENT_SCOPE } from '../src/publish-app-event';

const APP_DID = 'did:imajin:app_market';
const BUYER = 'did:imajin:buyer';

let publishAppEvent: typeof PublishAppEvent;

/** Seed a chain row for `{type, scope}`; reactors are `enabled` unless stated. */
function seedChain(type: string, scope: string | null, reactors: Array<[string, Record<string, unknown>?]>): void {
  chainRows.set(`${type}|${scope}`, {
    enabled: true,
    reactors: reactors.map(([rType, config]) => ({ type: rType, config: config ?? {}, enabled: true })),
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  for (const h of Object.values(handlers)) h.mockResolvedValue(undefined);
  chainRows.clear();
  // config.ts caches chain lookups for minutes — a fresh module per test keeps the seeded rows honest.
  vi.resetModules();
  ({ publishAppEvent } = await import('../src/publish-app-event'));
  seedChain('listing.purchased', APP_EVENT_SCOPE, [['attestation'], ['mjn'], ['settle'], ['notify']]);
  seedChain('tip.granted', APP_EVENT_SCOPE, [['attestation'], ['mjn'], ['notify', { scope: 'coffee:tip' }]]);
  seedChain('tip.sent', APP_EVENT_SCOPE, [['notify']]);
  seedChain('listing.create', APP_EVENT_SCOPE, [['emit']]);
});

describe('APP_EVENT_REACTORS ceiling', () => {
  it('is exactly notify + audit-log', () => {
    expect([...APP_EVENT_REACTORS].sort((a, b) => a.localeCompare(b))).toEqual(['audit-log', 'notify']);
  });
});

describe('publishAppEvent — money never moves', () => {
  it('app-sent listing.purchased: notify fires; settle, mjn, attestation never run', async () => {
    const result = await publishAppEvent('listing.purchased', { subject: BUYER, payload: { amount: 500, currency: 'USD' } }, APP_DID);

    expect(handlers.notify).toHaveBeenCalledTimes(1);
    expect(handlers['audit-log']).toHaveBeenCalledTimes(1);
    expect(handlers.settle).not.toHaveBeenCalled();
    expect(handlers.mjn).not.toHaveBeenCalled();
    expect(handlers.attestation).not.toHaveBeenCalled();
    expect(handlers.emit).not.toHaveBeenCalled();
    expect(result.ran).toEqual(['audit-log', 'notify']);
    expect(result.skipped).toEqual(['attestation', 'mjn', 'settle']);
  });

  it('app-sent tip.granted: notify fires; mjn credit and attestation never run', async () => {
    const result = await publishAppEvent('tip.granted', { subject: BUYER, payload: { amount: 3, currency: 'USD' } }, APP_DID);

    expect(handlers.notify).toHaveBeenCalledTimes(1);
    expect(handlers.mjn).not.toHaveBeenCalled();
    expect(handlers.attestation).not.toHaveBeenCalled();
    expect(handlers.settle).not.toHaveBeenCalled();
    expect(result.skipped).toEqual(['attestation', 'mjn']);
  });

  it('keeps the chain notify config (the notification the operator configured)', async () => {
    await publishAppEvent('tip.granted', { subject: BUYER }, APP_DID);
    expect(handlers.notify.mock.calls[0][1]).toEqual({ scope: 'coffee:tip' });
  });

  it('runs only the audit record for a chain with no notify reactor (emit is skipped too)', async () => {
    const result = await publishAppEvent('listing.create', { subject: BUYER }, APP_DID);

    expect(result.ran).toEqual(['audit-log']);
    expect(handlers.notify).not.toHaveBeenCalled();
    expect(handlers.emit).not.toHaveBeenCalled();
    expect(result.skipped).toEqual(['emit']);
  });

  it('an event type with no chain at all still leaves an audit record and nothing else', async () => {
    const result = await publishAppEvent('thing.nobody.configured', { subject: BUYER }, APP_DID);
    expect(result.ran).toEqual(['audit-log']);
    expect(result.skipped).toEqual([]);
  });
});

describe('publishAppEvent — chain configs come from scope apps only (#2717)', () => {
  it('ignores the node-default (scope NULL) row for the same event type', async () => {
    chainRows.clear();
    seedChain('tip.granted', null, [['settle'], ['notify', { scope: 'kernel:tip' }]]);

    const result = await publishAppEvent('tip.granted', { subject: BUYER }, APP_DID);

    expect(result.ran).toEqual(['audit-log']);
    expect(result.skipped).toEqual([]);
    expect(handlers.notify).not.toHaveBeenCalled();
    expect(handlers.settle).not.toHaveBeenCalled();
  });

  it('ignores a chain configured for another scope', async () => {
    chainRows.clear();
    seedChain('tip.granted', 'coffee', [['notify']]);

    const result = await publishAppEvent('tip.granted', { subject: BUYER }, APP_DID);

    expect(result.ran).toEqual(['audit-log']);
    expect(handlers.notify).not.toHaveBeenCalled();
  });

  it('does not fall back to the hardcoded kernel DEFAULTS: no apps row means audit-only', async () => {
    chainRows.clear();

    const result = await publishAppEvent('tip.granted', { subject: BUYER }, APP_DID);

    expect(result.ran).toEqual(['audit-log']);
    expect(handlers.notify).not.toHaveBeenCalled();
    expect(handlers.attestation).not.toHaveBeenCalled();
  });

  it('honours a disabled apps row as an empty chain', async () => {
    chainRows.set('tip.granted|apps', { enabled: false, reactors: [{ type: 'notify', config: {}, enabled: true }] });

    const result = await publishAppEvent('tip.granted', { subject: BUYER }, APP_DID);

    expect(result.ran).toEqual(['audit-log']);
  });
});

describe('publishAppEvent — origin and audit trail', () => {
  it('names the emitting app as issuer and payload.originAppDid on the audited event', async () => {
    await publishAppEvent('tip.sent', { subject: BUYER, payload: { amount: 1 }, correlationId: 'corr-1' }, APP_DID);

    const event = handlers['audit-log'].mock.calls[0][0];
    expect(event).toMatchObject({
      type: 'tip.sent',
      issuer: APP_DID,
      subject: BUYER,
      scope: APP_EVENT_SCOPE,
      correlationId: 'corr-1',
      payload: { amount: 1, origin: 'app', originAppDid: APP_DID },
    });
  });

  it('the audit write happens before any notification', async () => {
    const order: string[] = [];
    handlers['audit-log'].mockImplementation(async () => { order.push('audit-log'); });
    handlers.notify.mockImplementation(async () => { order.push('notify'); });

    await publishAppEvent('tip.granted', { subject: BUYER }, APP_DID);
    expect(order).toEqual(['audit-log', 'notify']);
  });

  it('an app cannot spoof its origin or opt out of the audit trail via payload keys', async () => {
    await publishAppEvent(
      'tip.sent',
      { subject: BUYER, payload: { origin: 'kernel', originAppDid: 'did:imajin:someone-else', preview: true, attestationId: 'att_forged', amount: 2 } },
      APP_DID,
    );

    const payload = handlers['audit-log'].mock.calls[0][0].payload;
    expect(payload.origin).toBe('app');
    expect(payload.originAppDid).toBe(APP_DID);
    expect(payload).not.toHaveProperty('preview');
    expect(payload).not.toHaveProperty('attestationId');
    expect(payload.amount).toBe(2);
  });

  it('does not mutate the caller-supplied payload', async () => {
    const payload = { preview: true, amount: 2 };
    await publishAppEvent('tip.sent', { subject: BUYER, payload }, APP_DID);
    expect(payload).toEqual({ preview: true, amount: 2 });
  });
});

describe('publishAppEvent — failure handling', () => {
  it('a throwing notify reactor does not throw out of publishAppEvent and is not reported as run', async () => {
    handlers.notify.mockRejectedValue(new Error('smtp down'));

    const result = await publishAppEvent('tip.granted', { subject: BUYER }, APP_DID);

    expect(result.ran).toEqual(['audit-log']);
  });

  it('an unregistered reactor is skipped without throwing', async () => {
    const saved = handlers.notify;
    delete handlers.notify;
    try {
      const result = await publishAppEvent('tip.granted', { subject: BUYER }, APP_DID);
      expect(result.ran).toEqual(['audit-log']);
    } finally {
      handlers.notify = saved;
    }
  });
});
