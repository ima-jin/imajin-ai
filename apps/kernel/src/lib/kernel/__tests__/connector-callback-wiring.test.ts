import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Callback route wiring (#1529) ───────────────────────────────────────────
//
// `createCallbackHandler` derives the landing page from `connectorId`, so a
// route that passes the wrong id (or forgets it) would silently strand the user
// on some other connector's page. The factory's own behaviour is covered in
// connector-oauth-routes.test.ts; this file only pins the per-route wiring.

const { exchangeQuickBooksMock, exchangeGitHubMock } = vi.hoisted(() => ({
  exchangeQuickBooksMock: vi.fn(async () => undefined),
  exchangeGitHubMock: vi.fn(async () => undefined),
}));

vi.mock('@imajin/auth', () => ({ requireAuth: vi.fn(), resolveActingDid: vi.fn() }));
vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));
vi.mock('@imajin/bus', () => ({ publish: vi.fn().mockResolvedValue(undefined) }));
vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => args,
  eq: (col: unknown, val: unknown) => ({ col, val }),
}));
vi.mock('@/src/db', () => ({ db: {}, channelLinks: {} }));
vi.mock('@/src/lib/vault', () => ({ deleteFromVault: vi.fn() }));
vi.mock('@/src/lib/kernel/cors', () => ({ corsHeaders: () => ({}) }));

vi.mock('next/server', () => ({
  NextResponse: {
    json: vi.fn((body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body })),
    redirect: vi.fn((url: string | URL) => ({ status: 307, headers: { location: String(url) } })),
  },
  NextRequest: class {},
}));

// Both connectors' state helpers verify successfully and sign no returnTo, so
// the redirect target is purely a function of the route's `connectorId`.
vi.mock('@/src/lib/quickbooks/oauth-state', () => ({ verifyState: () => ({ did: 'did:imajin:owner' }) }));
vi.mock('@/src/lib/github/oauth-state', () => ({ verifyState: () => ({ did: 'did:imajin:owner' }) }));
vi.mock('@/src/lib/quickbooks/connector', () => ({ exchangeCodeAndStore: exchangeQuickBooksMock }));
vi.mock('@/src/lib/github/connector', () => ({ exchangeCodeAndStore: exchangeGitHubMock }));

import { GET as quickbooksCallback } from '@/app/quickbooks/api/callback/route';
import { GET as githubCallback } from '@/app/github/api/callback/route';

function makeRequest(url: string) {
  return { url } as unknown as import('next/server').NextRequest;
}

beforeEach(() => {
  exchangeQuickBooksMock.mockClear();
  exchangeGitHubMock.mockClear();
});

describe('QuickBooks callback route', () => {
  const url = 'https://kernel.test/quickbooks/api/callback?code=abc&state=xyz&realmId=42';

  it('lands the browser on the QuickBooks connector page', async () => {
    const res = (await quickbooksCallback(makeRequest(url))) as { status: number; headers: { location: string } };
    expect(res.status).toBe(307);
    expect(res.headers.location).toBe('https://kernel.test/auth/connectors/quickbooks?connected=quickbooks');
  });

  it("forwards Intuit's realmId to the exchange", async () => {
    await quickbooksCallback(makeRequest(url));
    expect(exchangeQuickBooksMock).toHaveBeenCalledWith('did:imajin:owner', 'abc', '42');
  });

  it('redirects with missing_param when realmId is absent', async () => {
    const res = (await quickbooksCallback(
      makeRequest('https://kernel.test/quickbooks/api/callback?code=abc&state=xyz'),
    )) as { headers: { location: string } };
    expect(res.headers.location).toBe(
      'https://kernel.test/auth/connectors/quickbooks?error=missing_param&connector=quickbooks',
    );
    expect(exchangeQuickBooksMock).not.toHaveBeenCalled();
  });
});

describe('GitHub callback route', () => {
  const url = 'https://kernel.test/github/api/callback?code=abc&state=xyz';

  it('lands the browser on the GitHub connector page', async () => {
    const res = (await githubCallback(makeRequest(url))) as { status: number; headers: { location: string } };
    expect(res.status).toBe(307);
    expect(res.headers.location).toBe('https://kernel.test/auth/connectors/github?connected=github');
  });

  it('does not require a realmId (GitHub has no equivalent)', async () => {
    await githubCallback(makeRequest(url));
    expect(exchangeGitHubMock).toHaveBeenCalledWith('did:imajin:owner', 'abc');
  });
});
