import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Fake postgres.js tagged-template client: records each query's skeleton +
// interpolated values, and returns/throws queued outcomes in call order
// (INSERT ... RETURNING seq is always call 0; the grant lookup SELECT is
// call 1). Mirrors the `resolveWith` convention in supply-recorder.test.ts,
// extended with `queueError` so a lookup failure can be simulated without
// resorting to vi.doMock/vi.resetModules ceremony.
const { calls, fakeSql, queueResult, queueError } = vi.hoisted(() => {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const queue: Array<{ ok: true; value: unknown[] } | { ok: false; value: Error }> = [];
  const queueResult = (rows: unknown[]) => { queue.push({ ok: true, value: rows }); };
  const queueError = (err: Error) => { queue.push({ ok: false, value: err }); };
  const fakeSql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join(' ? '), values });
    const next = queue.shift();
    if (!next) return Promise.resolve([]);
    return next.ok ? Promise.resolve(next.value) : Promise.reject(next.value);
  };
  return { calls, fakeSql, queueResult, queueError };
});

vi.mock('@imajin/db', () => ({ getClient: () => fakeSql }));

import { deliverToSubscribers, _resetCapabilitiesByEventTypeCacheForTests } from '../src/subscriptions';
import type { BusEvent } from '../src/types';

const AUTH_URL = 'http://kernel.internal.test';
const INTERNAL_KEY = 'test-internal-key';
const AGENT = 'did:imajin:matchmaker-agent';
const OTHER_AGENT = 'did:imajin:other-agent';
const DELEGATOR = 'did:imajin:ryan';
const OTHER_DID = 'did:imajin:someone-else';

function makeEvent(overrides: Partial<BusEvent> = {}): BusEvent {
  return {
    type: 'availability.match.surfaced', // entitled by scope 'intros:propose'
    issuer: DELEGATOR,
    subject: DELEGATOR,
    scope: 'calendar',
    payload: { matchId: 'match_1' },
    ...overrides,
  };
}

function grantRow(overrides: Partial<{ agent_did: string; grant_id: string; audience: unknown }> = {}) {
  return {
    agent_did: AGENT,
    grant_id: 'grant_1',
    audience: { type: 'all' },
    ...overrides,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  calls.length = 0;
  _resetCapabilitiesByEventTypeCacheForTests();
  fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ delivered: true }) });
  vi.stubGlobal('fetch', fetchMock);
  process.env.AUTH_SERVICE_URL = AUTH_URL;
  process.env.AUTH_INTERNAL_API_KEY = INTERNAL_KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.AUTH_SERVICE_URL;
  delete process.env.AUTH_INTERNAL_API_KEY;
});

describe('deliverToSubscribers — fast path', () => {
  it('does no DB or network work for an event type no grant scope could ever entitle', async () => {
    await deliverToSubscribers(makeEvent({ type: 'ticket.purchased' }));
    expect(calls).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('deliverToSubscribers — persistence', () => {
  it('persists a durable log row for an entitleable event type even with no active grants', async () => {
    queueResult([{ seq: '42' }]); // INSERT ... RETURNING seq
    queueResult([]); // grant lookup — no active grants

    await deliverToSubscribers(makeEvent());

    expect(calls).toHaveLength(2);
    expect(calls[0].text).toContain('INSERT INTO kernel.event_subscription_log');
    expect(calls[0].text).toContain('RETURNING seq');
    expect(calls[0].values).toEqual(
      expect.arrayContaining([DELEGATOR, DELEGATOR, 'calendar', 'availability.match.surfaced']),
    );
    expect(calls[1].text).toContain('FROM auth.delegation_grants');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not attempt a grant lookup or delivery when the log write itself fails', async () => {
    queueError(new Error('connection terminated'));

    await expect(deliverToSubscribers(makeEvent())).resolves.toBeUndefined();

    expect(calls).toHaveLength(1); // only the failed INSERT attempt
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('deliverToSubscribers — entitlement + audience filtering', () => {
  it('pushes a live frame to an agent with an active, audience-matching grant', async () => {
    queueResult([{ seq: '7' }]);
    queueResult([grantRow()]);

    await deliverToSubscribers(makeEvent());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${AUTH_URL}/chat/api/internal/did-push`);
    expect(init.headers['x-internal-key']).toBe(INTERNAL_KEY);
    const body = JSON.parse(init.body as string);
    expect(body.targetDid).toBe(AGENT);
    expect(body.event).toMatchObject({
      type: 'bus_event',
      cursor: '7',
      eventType: 'availability.match.surfaced',
      issuer: DELEGATOR,
      subject: DELEGATOR,
      grantId: 'grant_1',
    });
    expect(body.event.id).toEqual(expect.any(String));
  });

  it('does not deliver to a grant whose audience excludes the event subject', async () => {
    queueResult([{ seq: '8' }]);
    queueResult([grantRow({ audience: { type: 'dids', values: [OTHER_DID] } })]);

    await deliverToSubscribers(makeEvent({ subject: DELEGATOR }));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('delivers to a "dids" audience grant when the subject is listed', async () => {
    queueResult([{ seq: '9' }]);
    queueResult([grantRow({ audience: { type: 'dids', values: [DELEGATOR] } })]);

    await deliverToSubscribers(makeEvent({ subject: DELEGATOR }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails closed (no delivery) when the grant lookup itself throws', async () => {
    queueResult([{ seq: '10' }]);
    queueError(new Error('db unreachable'));

    await expect(deliverToSubscribers(makeEvent())).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends exactly one push per agent even when multiple active grants entitle the same event', async () => {
    queueResult([{ seq: '11' }]);
    queueResult([
      grantRow({ grant_id: 'grant_a' }),
      grantRow({ grant_id: 'grant_b' }),
    ]);

    await deliverToSubscribers(makeEvent());

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('delivers independently to multiple distinct entitled agents', async () => {
    queueResult([{ seq: '12' }]);
    queueResult([grantRow({ agent_did: AGENT }), grantRow({ agent_did: OTHER_AGENT, grant_id: 'grant_2' })]);

    await deliverToSubscribers(makeEvent());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const targets = fetchMock.mock.calls.map(([, init]: [string, RequestInit]) => JSON.parse(init.body as string).targetDid);
    expect(targets.sort()).toEqual([AGENT, OTHER_AGENT].sort());
  });

  it('never throws even when the did-push fetch call itself rejects', async () => {
    queueResult([{ seq: '13' }]);
    queueResult([grantRow()]);
    fetchMock.mockRejectedValueOnce(new Error('network down'));

    await expect(deliverToSubscribers(makeEvent())).resolves.toBeUndefined();
  });
});

describe('deliverToSubscribers — missing delivery configuration', () => {
  it('skips live delivery (but keeps the durable row) when AUTH_SERVICE_URL is unset', async () => {
    delete process.env.AUTH_SERVICE_URL;
    queueResult([{ seq: '14' }]);
    queueResult([grantRow()]);

    await deliverToSubscribers(makeEvent());

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips live delivery when AUTH_INTERNAL_API_KEY is unset', async () => {
    delete process.env.AUTH_INTERNAL_API_KEY;
    queueResult([{ seq: '15' }]);
    queueResult([grantRow()]);

    await deliverToSubscribers(makeEvent());

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
