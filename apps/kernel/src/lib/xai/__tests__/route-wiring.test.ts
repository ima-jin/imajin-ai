/**
 * xAI route wiring tests (#1924).
 *
 * The wiring contract itself — the token, disconnect and scope-manifest
 * routes must bind to the right connector and nothing else — is shared with
 * every other token-paste connector; see `describeRouteWiringContract` in
 * `src/lib/kernel/__tests__/brain-connector-contract.ts` (#1927). Only the
 * provider-specific mock wiring and route imports live here.
 */
import { vi } from 'vitest';
import { describeRouteWiringContract } from '@/src/lib/kernel/__tests__/brain-connector-contract';

const {
  tokenOpts, disconnectOpts, manifestOpts, handlers,
  sealApiKey, keySealed, keyPending, revokeApiKey,
  findAsset, readScopes, publish,
} = vi.hoisted(() => ({
  tokenOpts: { current: null as Record<string, unknown> | null },
  disconnectOpts: { current: null as Record<string, unknown> | null },
  manifestOpts: { current: null as Record<string, unknown> | null },
  handlers: { GET: vi.fn(), POST: vi.fn(), OPTIONS: vi.fn() },
  sealApiKey: vi.fn(),
  keySealed: vi.fn(),
  keyPending: vi.fn(),
  revokeApiKey: vi.fn(),
  findAsset: vi.fn(),
  readScopes: vi.fn(),
  publish: vi.fn(),
}));

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

vi.mock('@/src/lib/xai/connector', () => ({
  sealApiKey,
  xaiKeySealed: keySealed,
  revokeApiKey,
}));

vi.mock('@/src/lib/xai/scope-manifest', () => ({
  findXaiManifestAsset: findAsset,
  readActiveXaiScopes: readScopes,
  publishXaiScopeManifest: publish,
  xaiKeySealed: keySealed,
  xaiKeyPending: keyPending,
  VALID_XAI_SCOPES: ['xai:infer'],
}));

// Importing evaluates each route module → each factory records its options.
const tokenRoute = await import('../../../../app/xai/api/token/route');
const disconnectRoute = await import('../../../../app/xai/api/disconnect/route');
const manifestRoute = await import('../../../../app/xai/api/scope-manifest/route');

describeRouteWiringContract({
  label: 'xAI',
  inferScope: 'xai:infer',
  tokenOpts,
  disconnectOpts,
  manifestOpts,
  tokenRoute: tokenRoute as Record<string, unknown>,
  disconnectRoute: disconnectRoute as Record<string, unknown>,
  manifestRoute: manifestRoute as Record<string, unknown>,
  sealApiKey,
  keySealed,
  keyPending,
  revokeApiKey,
  findAsset,
  readScopes,
  publish,
});
