import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ limit: vi.fn(), grace: vi.fn() }));
vi.mock('@/src/db', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: mocks.limit }) }) }) },
  onboardTokens: {},
}));
vi.mock('@/src/lib/auth/onboard', () => ({
  handleExpiredOrUsedToken: mocks.grace,
  addScopeMembership: vi.fn(),
  resolveOnboardIdentity: vi.fn(),
  resolveOnboardRedirect: vi.fn(),
}));
vi.mock('@/src/lib/auth/jwt', () => ({
  getSessionCookieOptions: () => ({ name: 'session', options: {} }),
  verifySessionToken: vi.fn(),
  createSessionToken: vi.fn(),
}));
vi.mock('@/src/lib/auth/emit-session-attestation', () => ({ emitSessionAttestation: vi.fn() }));
vi.mock('@/src/lib/auth/consume-invite', () => ({ consumePendingInvites: vi.fn() }));
vi.mock('@/src/lib/auth/onboard-tickets', () => ({ migrateOnboardTickets: vi.fn() }));
vi.mock('@imajin/bus', () => ({ publish: vi.fn() }));
vi.mock('@imajin/config', () => ({ rateLimit: () => ({ limited: false }), getClientIP: () => '127.0.0.1' }));

import { GET } from '../route';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('APP_URL', 'https://node.example.test');
  mocks.limit.mockResolvedValue([]);
});
afterEach(() => vi.unstubAllEnvs());

describe('onboarding has no default app destination', () => {
  it('passes the node origin to the expired-token session recovery', async () => {
    mocks.grace.mockResolvedValue(Response.redirect('https://node.example.test'));
    const response = await GET(new NextRequest('https://node.example.test/auth/api/onboard/verify?token=used'));
    expect(mocks.grace).toHaveBeenCalledWith('used', null, expect.anything(), 'https://node.example.test');
    expect(response.headers.get('location')).toBe('https://node.example.test/');
  });
  it('uses the same kernel fallback for the already-used link', async () => {
    mocks.grace.mockResolvedValue(null);
    mocks.limit.mockResolvedValueOnce([]).mockResolvedValueOnce([{ usedAt: new Date(), redirectUrl: null }]);
    const response = await GET(new NextRequest('https://node.example.test/auth/api/onboard/verify?token=used'));
    const body = await response.text();
    expect(body).toContain('href="https://node.example.test"');
    expect(body).not.toContain('events.imajin.ai');
  });
});
