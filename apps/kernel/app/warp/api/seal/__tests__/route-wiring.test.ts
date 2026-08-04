/**
 * Tests for the factory-wired Warp connector routes (#1428).
 *
 * `/warp/api/seal` and `/warp/api/scope-manifest` are pure wiring over shared
 * factories, so the behaviour under test is the *wiring itself*: that the seal
 * route is bound to the Warp connector and exposes DELETE (the owner-facing
 * revoke path this issue depends on), and that the scope-manifest route validates
 * against the Warp scope set and reports key status.
 *
 * Factory internals are covered by their own tests; both factories are mocked
 * here so this stays a wiring assertion and does not need a vault or a database.
 */
import { describe, it, expect, vi } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { staticSecretFactory, manifestFactory, warpConnectorStub, keySealed, keyPending } = vi.hoisted(() => {
  const handlers = { GET: vi.fn(), POST: vi.fn(), DELETE: vi.fn(), OPTIONS: vi.fn() };
  return {
    staticSecretFactory: vi.fn(() => handlers),
    manifestFactory: vi.fn(() => ({ GET: vi.fn(), POST: vi.fn(), OPTIONS: vi.fn() })),
    warpConnectorStub: { name: 'warp-connector-stub' },
    keySealed: vi.fn(async () => true),
    keyPending: vi.fn(async () => false),
  };
});

vi.mock('@/src/lib/kernel/connector-static-secret-route', () => ({
  createConnectorStaticSecretRoutes: staticSecretFactory,
}));

vi.mock('@/src/lib/kernel/scope-manifest-route', () => ({
  createConnectorScopeManifestRoute: manifestFactory,
}));

vi.mock('@/src/lib/warp/connector', () => ({ warpConnector: warpConnectorStub }));

vi.mock('@/src/lib/warp/scope-manifest', () => ({
  publishWarpScopeManifest: vi.fn(),
  readActiveWarpScopes: vi.fn(),
  findWarpManifestAsset: vi.fn(),
  warpKeySealed: keySealed,
  warpKeyPending: keyPending,
  VALID_WARP_SCOPES: ['warp:dispatch'],
}));

// ─── Subjects ────────────────────────────────────────────────────────────────

const sealRoute = await import('../route');
const manifestRoute = await import('../../scope-manifest/route');

// ─── Seal route ──────────────────────────────────────────────────────────────

describe('/warp/api/seal', () => {
  it('binds the shared static-secret factory to the Warp connector', () => {
    expect(staticSecretFactory).toHaveBeenCalledWith({
      name: 'Warp',
      connector: warpConnectorStub,
    });
  });

  it('exposes DELETE — the owner-facing revoke path that kills dispatch', () => {
    // The generic /api/vault/delegation/revoke route is admin-only and matches on
    // the node DID as subject, so it cannot revoke a per-DID connector grant.
    // Losing this export would silently remove the only owner-reachable revoke.
    expect(typeof sealRoute.DELETE).toBe('function');
  });

  it('exposes the full credential lifecycle', () => {
    for (const method of ['GET', 'POST', 'DELETE', 'OPTIONS'] as const) {
      expect(sealRoute[method]).toBeDefined();
    }
  });
});

// ─── Scope-manifest route ────────────────────────────────────────────────────

describe('/warp/api/scope-manifest', () => {
  it('validates fail-closed against the derived Warp scope set', () => {
    const [opts] = manifestFactory.mock.calls[0] as [
      { name: string; validScopes: readonly string[] },
    ];
    expect(opts.name).toBe('Warp');
    expect(opts.validScopes).toEqual(['warp:dispatch']);
  });

  it('reports whether a key is sealed so the connector card can render state', async () => {
    const [opts] = manifestFactory.mock.calls[0] as [
      { getExtraFields: (did: string) => Promise<Record<string, unknown>> },
    ];

    await expect(opts.getExtraFields('did:imajin:veteze')).resolves.toEqual({
      keySealed: true,
      credentialPending: false,
    });
    expect(keySealed).toHaveBeenCalledWith('did:imajin:veteze');
  });

  it('distinguishes "awaiting owner approval" from "not connected" (#1603)', async () => {
    // Under Tier 1 a sealed key is unreadable until the owner agent grants, so
    // keySealed is false while pending. Reporting only keySealed would render that
    // as "not connected" and invite re-pasting a key that is already stored.
    keySealed.mockResolvedValueOnce(false);
    keyPending.mockResolvedValueOnce(true);

    const [opts] = manifestFactory.mock.calls[0] as [
      { getExtraFields: (did: string) => Promise<Record<string, unknown>> },
    ];

    await expect(opts.getExtraFields('did:imajin:veteze')).resolves.toEqual({
      keySealed: false,
      credentialPending: true,
    });
  });

  it('exports the handlers the connector card calls', () => {
    for (const method of ['GET', 'POST', 'OPTIONS'] as const) {
      expect(manifestRoute[method]).toBeDefined();
    }
  });
});
