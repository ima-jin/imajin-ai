import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── resolveConfigDidWithPlatformFallback — two-tier credential model (#1775) ─
//
// QuickBooks-style connectors register the provider's OAuth app ONCE against a
// shared platform identity; every other user only ever owns their own tokens.
// A plain session request (no app-auth headers — a human clicking "Connect" in
// the kernel's own UI) never resolved a configDid before this, so it fell
// straight through to the session owner's own DID, which fails with
// `${name}_no_config` for everyone except whoever happened to configure the
// app themselves. This suite pins the fallback order: app-auth, then the
// owner's own config, then the shared `PLATFORM_DID` config.

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

/** Flattened out of the mock factory below to avoid nesting select/from/where/limit inline. */
function whereResult() {
  return { limit: () => dbSelectMock() };
}

vi.mock('@/src/db', () => ({
  db: { select: () => ({ from: () => ({ where: whereResult }) }) },
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

import { resolveConfigDidWithPlatformFallback } from '../connector-oauth-routes';

const OWNER = 'did:imajin:owner';
const APP = 'did:imajin:agrifortress';
const PLATFORM = 'did:imajin:platform';
const CONFIG_PREFIX = 'quickbooks-config';

function makeRequest(headers: Record<string, string> = {}) {
  return { url: 'https://kernel.test/quickbooks/api/connect', headers: new Headers(headers) } as unknown as
    import('next/server').NextRequest;
}

beforeEach(() => {
  requireAppAuthMock.mockReset();
  vaultFieldExistsMock.mockReset();
  vaultFieldExistsMock.mockResolvedValue(false);
  dbSelectMock.mockReset();
  dbSelectMock.mockResolvedValue([]);
  delete process.env.PLATFORM_DID;
});

afterEach(() => {
  delete process.env.PLATFORM_DID;
});

describe('resolveConfigDidWithPlatformFallback — app-auth takes precedence', () => {
  it('returns the app-auth-resolved configDid without checking the owner or the platform', async () => {
    process.env.PLATFORM_DID = PLATFORM;
    requireAppAuthMock.mockResolvedValue({
      appAuth: { appDid: APP, userDid: OWNER, scopes: [], attestationId: 'att' },
    });
    vaultFieldExistsMock.mockImplementation(async (field: string) => field === `${CONFIG_PREFIX}:${APP}`);

    const result = await resolveConfigDidWithPlatformFallback(
      makeRequest({ authorization: 'Bearer app-token' }),
      OWNER,
      CONFIG_PREFIX,
    );

    expect(result).toBe(APP);
    // Only the app-DID check ran — the owner's own field and the platform
    // field were never consulted because app-auth already answered.
    expect(vaultFieldExistsMock).toHaveBeenCalledTimes(1);
  });
});

describe('resolveConfigDidWithPlatformFallback — no app-auth headers (plain session)', () => {
  it('returns undefined (BYO-app, unchanged) when the owner already has their own config sealed', async () => {
    process.env.PLATFORM_DID = PLATFORM;
    vaultFieldExistsMock.mockImplementation(async (field: string) => field === `${CONFIG_PREFIX}:${OWNER}`);

    const result = await resolveConfigDidWithPlatformFallback(makeRequest(), OWNER, CONFIG_PREFIX);

    expect(result).toBeUndefined();
    expect(requireAppAuthMock).not.toHaveBeenCalled();
  });

  it('falls back to PLATFORM_DID when the owner has no config but the platform does', async () => {
    process.env.PLATFORM_DID = PLATFORM;
    vaultFieldExistsMock.mockImplementation(async (field: string) => field === `${CONFIG_PREFIX}:${PLATFORM}`);

    const result = await resolveConfigDidWithPlatformFallback(makeRequest(), OWNER, CONFIG_PREFIX);

    expect(result).toBe(PLATFORM);
  });

  it('returns undefined when neither the owner nor PLATFORM_DID has config sealed', async () => {
    process.env.PLATFORM_DID = PLATFORM;
    vaultFieldExistsMock.mockResolvedValue(false);

    const result = await resolveConfigDidWithPlatformFallback(makeRequest(), OWNER, CONFIG_PREFIX);

    expect(result).toBeUndefined();
  });

  it('returns undefined without checking the vault a second time when PLATFORM_DID is unset', async () => {
    delete process.env.PLATFORM_DID;
    vaultFieldExistsMock.mockResolvedValue(false);

    const result = await resolveConfigDidWithPlatformFallback(makeRequest(), OWNER, CONFIG_PREFIX);

    expect(result).toBeUndefined();
    // One call to check the owner's own field; no platform DID to check next.
    expect(vaultFieldExistsMock).toHaveBeenCalledTimes(1);
  });

  it('ignores a blank PLATFORM_DID the same as unset', async () => {
    process.env.PLATFORM_DID = '   ';
    vaultFieldExistsMock.mockResolvedValue(false);

    const result = await resolveConfigDidWithPlatformFallback(makeRequest(), OWNER, CONFIG_PREFIX);

    expect(result).toBeUndefined();
    expect(vaultFieldExistsMock).toHaveBeenCalledTimes(1);
  });
});
