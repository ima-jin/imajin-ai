/**
 * The `settle` reactor (#2642) settles IN-PROCESS through the executor the
 * kernel injects at boot (`registerSettleExecutor`) — it makes no HTTP call to
 * `/pay/api/settle` and no longer reads `PAY_SERVICE_URL` / `PAY_SERVICE_API_KEY`
 * (the shared key is not accepted on that route any more).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BusEvent } from '../src/types';

const { publishMock } = vi.hoisted(() => ({ publishMock: vi.fn() }));
vi.mock('../src/publish', () => ({ publish: publishMock }));

import { settleReactor, registerSettleExecutor, getSettleExecutor, type SettleExecutor } from '../src/reactors/settle';

const BUYER = 'did:imajin:buyer';
const SELLER = 'did:imajin:seller';

function makeEvent(overrides: Partial<BusEvent> = {}): BusEvent {
  return {
    type: 'order.completed',
    issuer: BUYER,
    subject: SELLER,
    scope: 'market',
    payload: {
      orderId: 'order_1',
      eventId: 'event_1',
      buyerDid: BUYER,
      amount: 10_000,
      currency: 'CAD',
      funded: true,
      funded_provider: 'stripe',
      metadata: { source: 'test' },
      fairManifest: { version: '1', chain: [{ did: SELLER, role: 'seller', share: 1 }] },
    },
    ...overrides,
  };
}

const SETTLED = { settled: true as const, batchId: 'batch_1', transactions: ['tx_1'], total_amount: 100, recipients: 1, source: 'external' };

let executor: ReturnType<typeof vi.fn<SettleExecutor>>;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  publishMock.mockResolvedValue({});
  executor = vi.fn<SettleExecutor>().mockResolvedValue(SETTLED);
  registerSettleExecutor(executor);
  fetchSpy = vi.fn().mockRejectedValue(new Error('settle must not use HTTP'));
  vi.stubGlobal('fetch', fetchSpy);
  // Even with the legacy env present, nothing may be read from it.
  vi.stubEnv('PAY_SERVICE_URL', 'https://pay.kernel.test');
  vi.stubEnv('PAY_SERVICE_API_KEY', 'legacy-shared-key');
});

afterEach(() => {
  registerSettleExecutor(null);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('settle reactor — in-process settlement (#2642)', () => {
  it('calls the registered executor in-process and never touches HTTP', async () => {
    await settleReactor(makeEvent(), {});

    expect(executor).toHaveBeenCalledTimes(1);
    const params = executor.mock.calls[0][0];
    expect(params).toMatchObject({ from_did: BUYER, service: 'market', type: 'order.completed', funded: true, funded_provider: 'stripe', currency: 'CAD', metadata: { source: 'test' } });
    // The resolved chain is carried over, summing to the settled total.
    const chainTotal = params.fair_manifest.chain.reduce((sum, c) => sum + c.amount, 0);
    expect(chainTotal).toBeCloseTo(params.total_amount, 2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('settles (and emits settlement.completed) with no PAY_SERVICE_URL / PAY_SERVICE_API_KEY set at all', async () => {
    vi.unstubAllEnvs();
    delete process.env.PAY_SERVICE_URL;
    delete process.env.PAY_SERVICE_API_KEY;

    await settleReactor(makeEvent(), {});

    expect(executor).toHaveBeenCalledTimes(1);
    expect(publishMock).toHaveBeenCalledWith('settlement.completed', expect.objectContaining({ payload: expect.objectContaining({ orderId: 'order_1', buyerDid: BUYER, amount: 10_000 }) }));
  });

  it('honours settle_service / settle_type overrides from the payload', async () => {
    const event = makeEvent();
    event.payload = { ...event.payload, settle_service: 'coffee', settle_type: 'tip' };

    await settleReactor(event, {});

    expect(executor.mock.calls[0][0]).toMatchObject({ service: 'coffee', type: 'tip' });
  });

  it('does not read the retired env vars anywhere in the reactor source', () => {
    const source = readFileSync(join(__dirname, '../src/reactors/settle.ts'), 'utf-8')
      // The header comment documents the removal; only code may not touch the env.
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');

    expect(source).not.toMatch(/process\.env\.PAY_SERVICE_API_KEY/);
    expect(source).not.toMatch(/process\.env\.PAY_SERVICE_URL/);
    expect(source).not.toMatch(/fetch\(/);
  });

  it('logs and skips (no throw, no HTTP fallback) when no executor is registered — settle exists only in the kernel process', async () => {
    registerSettleExecutor(null);

    await expect(settleReactor(makeEvent(), {})).resolves.toBeUndefined();

    expect(getSettleExecutor()).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('does not emit settlement.completed when the settlement is refused', async () => {
    executor.mockResolvedValue({ error: 'Insufficient MJN balance', status: 400 });

    await settleReactor(makeEvent(), {});

    expect(executor).toHaveBeenCalledTimes(1);
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('swallows an executor crash (the chain must not abort) and emits nothing', async () => {
    executor.mockRejectedValue(new Error('db down'));

    await expect(settleReactor(makeEvent(), {})).resolves.toBeUndefined();

    expect(publishMock).not.toHaveBeenCalled();
  });

  it.each([
    ['no amount', { amount: undefined }],
    ['a non-numeric amount', { amount: 'ten' }],
  ])('skips settlement with %s', async (_label, patch) => {
    const event = makeEvent();
    event.payload = { ...event.payload, ...patch };

    await settleReactor(event, {});

    expect(executor).not.toHaveBeenCalled();
  });

  it('skips settlement when there is no fair chain to settle (the old route 400 on a missing fair_manifest)', async () => {
    const event = makeEvent();
    event.payload = { ...event.payload, fairManifest: null };

    await settleReactor(event, {});

    expect(executor).not.toHaveBeenCalled();
  });

  it('skips settlement when there is no payer (neither buyerDid nor issuer)', async () => {
    const event = makeEvent({ issuer: '' });
    event.payload = { ...event.payload, buyerDid: undefined };

    await settleReactor(event, {});

    expect(executor).not.toHaveBeenCalled();
  });

  it('settles but skips settlement.completed when the event has no orderId', async () => {
    const event = makeEvent();
    event.payload = { ...event.payload, orderId: undefined, metadata: undefined };

    await settleReactor(event, {});

    expect(executor).toHaveBeenCalledTimes(1);
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('a failing settlement.completed publish is non-fatal', async () => {
    publishMock.mockRejectedValue(new Error('bus down'));

    await expect(settleReactor(makeEvent(), {})).resolves.toBeUndefined();

    expect(executor).toHaveBeenCalledTimes(1);
  });
});
