/**
 * publishAppEvent() — the app-origin publish path (#2638 / #2641, ruled "b").
 *
 * The real DEFAULTS chain config is used (fake DB returns no rows), so these
 * tests prove the ceiling against the chains that actually exist:
 * `listing.purchased` = attestation + mjn + settle + notify and
 * `tip.granted` = attestation + mjn + notify. Only notify and audit-log may run.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

const { fakeSql } = vi.hoisted(() => ({
  fakeSql: (_strings: TemplateStringsArray, ..._values: unknown[]) => Promise.resolve([]),
}));
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

import { publishAppEvent, APP_EVENT_REACTORS, APP_EVENT_SCOPE } from '../src/publish-app-event';

const APP_DID = 'did:imajin:app_market';
const BUYER = 'did:imajin:buyer';

beforeEach(() => {
  vi.clearAllMocks();
  for (const h of Object.values(handlers)) h.mockResolvedValue(undefined);
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
