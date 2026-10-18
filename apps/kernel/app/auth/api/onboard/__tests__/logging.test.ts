import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  deliver: vi.fn(), select: vi.fn(), sql: vi.fn(), error: vi.fn(), info: vi.fn(),
}));
vi.mock('@/src/lib/auth/onboard-delivery', () => ({ deliverOnboardEmail: mocks.deliver }));
vi.mock('@/src/db', () => ({
  db: { select: mocks.select },
  credentials: { did: 'did', type: 'type', value: 'value' },
  identities: {}, invites: {},
}));
vi.mock('@imajin/db', () => ({ getClient: () => mocks.sql }));
vi.mock('@imajin/config', () => ({
  corsHeaders: () => ({}), getClientIP: () => '127.0.0.1',
  rateLimit: () => ({ limited: false }),
}));
vi.mock('@imajin/logger', () => ({
  withLogger: (_service: string, handler: (request: unknown, ctx: unknown) => unknown) =>
    (request: unknown) => handler(request, { log: { error: mocks.error, info: mocks.info } }),
}));

import { POST } from '../route';

function request(mode?: string) {
  return new NextRequest('https://kernel.test/auth/api/onboard', {
    method: 'POST',
    body: JSON.stringify({
      email: ' Buyer@example.test ', mode, redirectUrl: 'https://private.test/?token=fixture',
    }),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.deliver.mockResolvedValue({ success: true });
});

describe('onboarding safe logging', () => {
  it('omits normalized email from unknown-account login logging', async () => {
    mocks.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
      }),
    });
    mocks.sql.mockResolvedValue([]);
    const response = await POST(request('login'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sent: true });
    expect(mocks.info.mock.calls).toEqual([
      [{ status: 200, code: 'ONBOARD_LOGIN_ACCOUNT_NOT_FOUND' }, 'Login requested for unknown email'],
    ]);
    expect(mocks.deliver).not.toHaveBeenCalled();
  });

  it('logs a fixed delivery-failure code rather than returned provider details', async () => {
    mocks.deliver.mockResolvedValue({ success: false, error: 'buyer@example.test Bearer fixture https://private.test' });
    const response = await POST(request());
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'Failed to send verification email' });
    expect(mocks.error.mock.calls).toEqual([
      [{ status: 502, code: 'ONBOARD_EMAIL_DELIVERY_FAILED' }, 'Failed to send onboard email'],
    ]);
  });

  it.each([
    new Error('buyer@example.test Bearer fixture https://private.test/?token=fixture'),
    { email: 'buyer@example.test', token: 'fixture', url: 'https://private.test' },
  ])('logs only fixed metadata for a thrown sensitive value', async (failure) => {
    mocks.deliver.mockRejectedValue(failure);
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to initiate onboarding' });
    expect(mocks.error.mock.calls).toEqual([
      [{ status: 500, code: 'ONBOARD_START_FAILED' }, 'Onboard start error'],
    ]);
  });
});
