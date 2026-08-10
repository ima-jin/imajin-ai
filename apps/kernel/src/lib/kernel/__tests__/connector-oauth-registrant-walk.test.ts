import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── resolveConfigDidFromAppAuth — registrant DID walk (#1770) ──────────────
//
// The OAuth connect handler resolves `configDid` from the app-auth appDid, but
// the app's OAuth client credentials can be sealed on the REGISTRANT DID
// (`registry_apps.ownerDid` — the org/person who registered the app) instead
// of the app DID directly. This mirrors the hop `resolveBrain` (#1621) already
// walks for inference credentials (see `brain.test.ts`'s "app registrant org
// DID walk" suite).

const { requireAppAuthMock, vaultFieldExistsMock, dbSelectMock } = vi.hoisted(() => ({
  requireAppAuthMock: vi.fn(),
  vaultFieldExistsMock: vi.fn(),
  dbSelectMock: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: vi.fn(),
  resolveActingDid: vi.fn(),
  requireAppAuth: requireAppAuthMock,
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

vi.mock('@imajin/bus', () => ({ publish: vi.fn().mockResolvedValue(undefined) }));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => args,
  eq: (col: unknown, val: unknown) => ({ col, val }),
}));

vi.mock('@/src/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => dbSelectMock(),
        }),
      }),
    }),
  },
  channelLinks: {},
  registryApps: { appDid: 'app_did', ownerDid: 'owner_did' },
}));

vi.mock('@/src/lib/vault', () => ({
  deleteFromVault: vi.fn(),
  vaultFieldExists: vaultFieldExistsMock,
}));

vi.mock('@/src/lib/kernel/cors', () => ({ corsHeaders: () => ({}) }));

vi.mock('next/server', () => ({
  NextResponse: {
    json: vi.fn((body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body })),
    redirect: vi.fn((url: string | URL) => ({ status: 307, headers: { location: String(url) } })),
  },
  NextRequest: class {},
}));

import { resolveConfigDidFromAppAuth } from '../connector-oauth-routes';

const APP = 'did:imajin:agrifortress';
const REGISTRANT = 'did:imajin:agrifortress-org';
const CONFIG_PREFIX = 'quickbooks-config';

function makeRequest(headers: Record<string, string> = {}) {
  return { url: 'https://kernel.test/quickbooks/api/connect', headers: new Headers(headers) } as unknown as
    import('next/server').NextRequest;
}

beforeEach(() => {
  requireAppAuthMock.mockReset();
  requireAppAuthMock.mockResolvedValue({
    appAuth: { appDid: APP, userDid: 'did:imajin:owner', scopes: [], attestationId: 'att' },
  });
  vaultFieldExistsMock.mockReset();
  dbSelectMock.mockReset();
  dbSelectMock.mockResolvedValue([]);
});

describe('resolveConfigDidFromAppAuth — configPrefix omitted (#1704, unchanged)', () => {
  it('returns the app DID directly without checking the vault at all', async () => {
    const result = await resolveConfigDidFromAppAuth(makeRequest({ authorization: 'Bearer app-token' }));

    expect(result).toBe(APP);
    expect(vaultFieldExistsMock).not.toHaveBeenCalled();
  });
});

describe('resolveConfigDidFromAppAuth — configPrefix supplied (#1770)', () => {
  it('returns the app DID when config is already sealed there', async () => {
    vaultFieldExistsMock.mockImplementation(async (field: string) => field === `${CONFIG_PREFIX}:${APP}`);

    const result = await resolveConfigDidFromAppAuth(
      makeRequest({ authorization: 'Bearer app-token' }),
      CONFIG_PREFIX,
    );

    expect(result).toBe(APP);
    // The app DID already had config, so the registrant lookup must never run.
    expect(dbSelectMock).not.toHaveBeenCalled();
  });

  it('walks to the registrant DID when the app DID has no sealed config', async () => {
    vaultFieldExistsMock.mockImplementation(async (field: string) => field === `${CONFIG_PREFIX}:${REGISTRANT}`);
    dbSelectMock.mockResolvedValueOnce([{ ownerDid: REGISTRANT }]);

    const result = await resolveConfigDidFromAppAuth(
      makeRequest({ authorization: 'Bearer app-token' }),
      CONFIG_PREFIX,
    );

    expect(result).toBe(REGISTRANT);
  });

  it('falls back to the app DID when neither the app nor the registrant has config', async () => {
    vaultFieldExistsMock.mockResolvedValue(false);
    dbSelectMock.mockResolvedValueOnce([{ ownerDid: REGISTRANT }]);

    const result = await resolveConfigDidFromAppAuth(
      makeRequest({ authorization: 'Bearer app-token' }),
      CONFIG_PREFIX,
    );

    expect(result).toBe(APP);
  });

  it('falls back to the app DID when the app is not in the registry at all', async () => {
    vaultFieldExistsMock.mockResolvedValue(false);
    dbSelectMock.mockResolvedValueOnce([]);

    const result = await resolveConfigDidFromAppAuth(
      makeRequest({ authorization: 'Bearer app-token' }),
      CONFIG_PREFIX,
    );

    expect(result).toBe(APP);
  });

  it('returns undefined (never reaching the vault) when no app-auth headers are present', async () => {
    const result = await resolveConfigDidFromAppAuth(makeRequest(), CONFIG_PREFIX);

    expect(result).toBeUndefined();
    expect(requireAppAuthMock).not.toHaveBeenCalled();
    expect(vaultFieldExistsMock).not.toHaveBeenCalled();
  });
});
