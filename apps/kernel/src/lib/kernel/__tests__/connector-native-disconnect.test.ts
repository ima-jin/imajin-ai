import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── connector-native-disconnect.ts — revoke-all handler tests (#1592) ────────
//
// A native connector has no credential, so "disconnect" is entirely a grant
// operation: publish the scope-manifest empty, then make sure nothing survived.
// The properties worth pinning are the fail-closed ones — a publish that throws
// must leave grants alone, and a revoke that only half-landed must not be
// reported as success.

const { requireAuthMock, resolveActingDidMock, publishBusMock, updateWhereMock, revokeVaultGrantsMock } = vi.hoisted(() => ({
  requireAuthMock: vi.fn(),
  resolveActingDidMock: vi.fn(() => 'did:imajin:owner'),
  publishBusMock: vi.fn().mockResolvedValue(undefined),
  updateWhereMock: vi.fn().mockResolvedValue([]),
  revokeVaultGrantsMock: vi.fn().mockResolvedValue(0),
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: requireAuthMock,
  resolveActingDid: resolveActingDidMock,
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

vi.mock('@imajin/bus', () => ({ publish: publishBusMock }));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => args,
  eq: (col: unknown, val: unknown) => ({ col, val }),
}));

vi.mock('@/src/db', () => ({
  db: { update: () => ({ set: () => ({ where: updateWhereMock }) }) },
  channelLinks: {},
}));

vi.mock('@/src/lib/vault', () => ({
  revokeVaultDelegationGrantsForConnector: revokeVaultGrantsMock,
}));

vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({}),
  corsOptions: () => ({ status: 204 }),
}));

vi.mock('next/server', () => ({
  NextResponse: {
    json: vi.fn((body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    })),
  },
  NextRequest: class {},
}));

import { createNativeDisconnectHandler } from '../connector-native-disconnect';

interface JsonResult {
  status: number;
  json(): Promise<Record<string, unknown>>;
}

function makeRequest() {
  return { url: 'https://kernel.test/mcp/api/disconnect' } as unknown as import('next/server').NextRequest;
}

/** Handler over stub publish/read fns, defaulting to a clean revoke. */
function handlerWith(overrides: {
  publishScopeManifest?: (ownerDid: string, scopes: readonly string[]) => Promise<string>;
  readActiveScopes?: (ownerDid: string) => Promise<string[]>;
} = {}) {
  return createNativeDisconnectHandler({
    channel: 'mcp',
    connectorDid: 'did:imajin:mcp-connector',
    connectorName: 'mcp',
    publishScopeManifest: overrides.publishScopeManifest ?? vi.fn(async () => 'asset_cleared'),
    readActiveScopes: overrides.readActiveScopes ?? vi.fn(async () => []),
  });
}

beforeEach(() => {
  requireAuthMock.mockReset();
  requireAuthMock.mockResolvedValue({ identity: {} });
  resolveActingDidMock.mockReset();
  resolveActingDidMock.mockReturnValue('did:imajin:owner');
  publishBusMock.mockClear();
  updateWhereMock.mockClear();
  updateWhereMock.mockResolvedValue([]);
  revokeVaultGrantsMock.mockClear();
  revokeVaultGrantsMock.mockResolvedValue(0);
});

describe('createNativeDisconnectHandler — the happy path', () => {
  it('publishes the manifest with an empty scope set', async () => {
    const publishScopeManifest = vi.fn(async () => 'asset_cleared');
    const { POST } = handlerWith({ publishScopeManifest });

    await POST(makeRequest());

    expect(publishScopeManifest).toHaveBeenCalledWith('did:imajin:owner', []);
  });

  it('reports the connector disconnected with no scopes left', async () => {
    const { POST } = handlerWith();

    const res = (await POST(makeRequest())) as unknown as JsonResult;

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      connected: false,
      activeScopes: [],
      manifestAssetId: 'asset_cleared',
    });
  });

  it('sweeps residual channel_links rows the manifest publish could not reach', async () => {
    const { POST } = handlerWith();

    await POST(makeRequest());

    // Rows written against an older manifest asset id are outside the publish's
    // `channelUid LIKE '<assetId>#%'` filter — without this sweep they stay active.
    expect(updateWhereMock).toHaveBeenCalledTimes(1);
  });

  it('publishes a connector.disconnected event for the audit trail', async () => {
    const { POST } = handlerWith();

    await POST(makeRequest());

    expect(publishBusMock).toHaveBeenCalledWith(
      'connector.disconnected',
      expect.objectContaining({
        issuer: 'did:imajin:owner',
        subject: 'did:imajin:owner',
        scope: 'mcp',
      }),
    );
  });

  it('sweeps dangling vault_delegation_grants rows for this connector + owner (#1720)', async () => {
    const { POST } = handlerWith();

    await POST(makeRequest());

    expect(revokeVaultGrantsMock).toHaveBeenCalledWith('mcp', 'did:imajin:owner');
  });

  it('still succeeds when the bus publish rejects (audit is not the revoke)', async () => {
    publishBusMock.mockRejectedValueOnce(new Error('bus down'));
    const { POST } = handlerWith();

    const res = (await POST(makeRequest())) as unknown as JsonResult;

    expect(res.status).toBe(200);
  });
});

describe('createNativeDisconnectHandler — fail-closed', () => {
  it('rejects an unauthenticated caller without touching any grant', async () => {
    requireAuthMock.mockResolvedValue({ error: 'unauthorized', status: 401 });
    const publishScopeManifest = vi.fn(async () => 'asset_cleared');
    const { POST } = handlerWith({ publishScopeManifest });

    const res = (await POST(makeRequest())) as unknown as JsonResult;

    expect(res.status).toBe(401);
    expect(publishScopeManifest).not.toHaveBeenCalled();
    expect(updateWhereMock).not.toHaveBeenCalled();
  });

  it('leaves grants intact and surfaces the error when the publish throws', async () => {
    const { POST } = handlerWith({
      publishScopeManifest: vi.fn(async () => { throw new Error('asset locked'); }),
    });

    const res = (await POST(makeRequest())) as unknown as JsonResult;

    expect(res.status).toBe(500);
    expect(String((await res.json()).detail)).toMatch(/asset locked/);
    // The sweep is what would revoke rows outside the manifest — never reached,
    // so a failed publish cannot half-clear the owner's grants.
    expect(updateWhereMock).not.toHaveBeenCalled();
    expect(publishBusMock).not.toHaveBeenCalled();
  });

  it('surfaces a failed residual sweep rather than claiming success', async () => {
    updateWhereMock.mockRejectedValueOnce(new Error('deadlock'));
    const { POST } = handlerWith();

    const res = (await POST(makeRequest())) as unknown as JsonResult;

    expect(res.status).toBe(500);
    expect(publishBusMock).not.toHaveBeenCalled();
  });

  it('surfaces a failed vault delegation-grant sweep rather than claiming success (#1720)', async () => {
    revokeVaultGrantsMock.mockRejectedValueOnce(new Error('db unavailable'));
    const { POST } = handlerWith();

    const res = (await POST(makeRequest())) as unknown as JsonResult;

    expect(res.status).toBe(500);
    expect(publishBusMock).not.toHaveBeenCalled();
  });

  it('refuses to report disconnected while a scope is still active', async () => {
    const { POST } = handlerWith({
      readActiveScopes: vi.fn(async () => ['media:read']),
    });

    const res = (await POST(makeRequest())) as unknown as JsonResult;
    const body = await res.json();

    expect(res.status).toBe(500);
    // The card needs the survivors by name — "something went wrong" would leave
    // the owner unable to see what is still granted.
    expect(body.activeScopes).toEqual(['media:read']);
    expect(body.connected).toBeUndefined();
    expect(publishBusMock).not.toHaveBeenCalled();
  });
});
