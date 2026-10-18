import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), send: vi.fn(), error: vi.fn() }));
vi.mock('@/src/lib/auth/app-onboard', () => ({
  authenticateOnboardApp: mocks.authenticate,
  sendOrderOnboard: mocks.send,
  onboardSendBody: { safeParse: () => ({ success: true, data: { transactionId: 'tx_fixture' } }) },
}));
vi.mock('@imajin/config', () => ({ corsHeaders: () => ({}) }));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ error: mocks.error }) }));

import { POST } from '../route';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.authenticate.mockResolvedValue({ appDid: 'did:imajin:app' });
});

describe('order onboarding safe logging', () => {
  it.each(['authentication', 'delivery'])('logs only fixed metadata for a sensitive %s exception', async (stage) => {
    const failure = new Error('buyer@example.test Bearer fixture https://private.test/?token=fixture');
    if (stage === 'authentication') mocks.authenticate.mockRejectedValue(failure);
    else mocks.send.mockRejectedValue(failure);
    const response = await POST(new NextRequest('https://kernel.test/auth/api/onboard/send', {
      method: 'POST', body: JSON.stringify({ transactionId: 'tx_fixture' }),
    }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Onboarding delivery unavailable' });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.error.mock.calls).toEqual([
      [{ status: 503, code: 'ONBOARD_DELIVERY_UNAVAILABLE' }, 'Order onboarding delivery unavailable'],
    ]);
  });
});
