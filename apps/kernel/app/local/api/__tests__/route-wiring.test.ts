/**
 * Local connector route wiring tests (#1957).
 *
 * Unlike every other token-paste connector, `local`'s token route and
 * scope-manifest route are deliberately wired to TWO DIFFERENT readiness
 * signals (`bearerTokenSealed` vs `baseUrlConfigured` — see
 * `src/lib/local/connector.ts`'s header for why), so the shared
 * `describeRouteWiringContract` in `brain-connector-contract.ts` — which
 * assumes one `keySealed` function backs both routes — does not fit. This
 * file pins the same "wired to the right connector, and nothing else"
 * property by hand instead.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';

const tokenOpts: { current: Record<string, unknown> | null } = { current: null };
const disconnectOpts: { current: Record<string, unknown> | null } = { current: null };
const manifestOpts: { current: Record<string, unknown> | null } = { current: null };
const handlers = { GET: vi.fn(), POST: vi.fn(), OPTIONS: vi.fn() };

vi.mock('@/src/lib/kernel/connector-token-route', () => ({
  createConnectorTokenRoutes: vi.fn((opts: Record<string, unknown>) => {
    tokenOpts.current = opts;
    return handlers;
  }),
  createConnectorTokenDisconnectRoute: vi.fn((opts: Record<string, unknown>) => {
    disconnectOpts.current = opts;
    return handlers;
  }),
}));

vi.mock('@/src/lib/kernel/scope-manifest-route', () => ({
  createConnectorScopeManifestRoute: vi.fn((opts: Record<string, unknown>) => {
    manifestOpts.current = opts;
    return handlers;
  }),
}));

const sealBearerToken = vi.fn();
const bearerTokenSealed = vi.fn();
const disconnect = vi.fn();
const baseUrlConfigured = vi.fn();
const bearerTokenPending = vi.fn();

vi.mock('@/src/lib/local/connector', () => ({
  sealBearerToken,
  bearerTokenSealed,
  disconnect,
  baseUrlConfigured,
  bearerTokenPending,
}));

const findLocalManifestAsset = vi.fn();
const readActiveLocalScopes = vi.fn();
const publishLocalScopeManifest = vi.fn();

vi.mock('@/src/lib/local/scope-manifest', () => ({
  findLocalManifestAsset,
  readActiveLocalScopes,
  publishLocalScopeManifest,
  VALID_LOCAL_SCOPES: ['local:infer'],
}));

const tokenRoute = await import('../token/route');
const disconnectRoute = await import('../disconnect/route');
const manifestRoute = await import('../scope-manifest/route');

const OWNER = 'did:imajin:owner';

describe('local connector route wiring', () => {
  beforeEach(() => {
    baseUrlConfigured.mockReset();
    bearerTokenPending.mockReset();
  });

  describe('token route', () => {
    it('seals through the bearer-token functions, not baseUrl readiness', () => {
      expect(tokenOpts.current).toMatchObject({ name: 'Local Inference' });
      expect(tokenOpts.current?.sealApiKey).toBe(sealBearerToken);
      expect(tokenOpts.current?.keySealed).toBe(bearerTokenSealed);
    });

    it('exports the full credential lifecycle', () => {
      for (const method of ['GET', 'POST', 'OPTIONS'] as const) {
        expect(tokenRoute[method]).toBeDefined();
      }
    });
  });

  describe('disconnect route', () => {
    it('revokes through the local connector\u2019s full disconnect', () => {
      expect(disconnectOpts.current).toMatchObject({ name: 'Local Inference' });
      expect(disconnectOpts.current?.revokeApiKey).toBe(disconnect);
    });

    it('exposes POST and OPTIONS only', () => {
      expect(disconnectRoute.POST).toBeDefined();
      expect(disconnectRoute.OPTIONS).toBeDefined();
      expect(disconnectRoute.GET).toBeUndefined();
    });
  });

  describe('scope-manifest route', () => {
    it('validates fail-closed against the derived local scope list', () => {
      expect(manifestOpts.current).toMatchObject({ name: 'Local Inference', validScopes: ['local:infer'] });
      expect(manifestOpts.current?.publish).toBe(publishLocalScopeManifest);
      expect(manifestOpts.current?.readActiveScopes).toBe(readActiveLocalScopes);
      expect(manifestOpts.current?.findManifestAsset).toBe(findLocalManifestAsset);
      expect(manifestRoute.GET).toBeDefined();
    });

    it.each([
      ['baseUrl configured, no pending bearer token', true, false, { keySealed: true, credentialPending: false }],
      ['no baseUrl, bearer token awaiting approval', false, true, { keySealed: false, credentialPending: true }],
    ])('reports %s', async (_label, sealed, pending, expected) => {
      baseUrlConfigured.mockResolvedValue(sealed);
      bearerTokenPending.mockResolvedValue(pending);

      const getExtraFields = manifestOpts.current?.getExtraFields as (did: string) => Promise<unknown>;

      expect(await getExtraFields(OWNER)).toEqual(expected);
      expect(baseUrlConfigured).toHaveBeenCalledWith(OWNER);
      expect(bearerTokenPending).toHaveBeenCalledWith(OWNER);
    });
  });
});
