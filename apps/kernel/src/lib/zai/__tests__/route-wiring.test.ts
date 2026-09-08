/**
 * Z.ai route wiring tests (#1931).
 *
 * The wiring contract, and the mock-setup boilerplate for the two
 * connector-agnostic route factories, are shared with every other
 * token-paste connector — see `mockRouteWiringFactories` and
 * `describeRouteWiringContract` in
 * `src/lib/kernel/__tests__/brain-connector-contract.ts`. Only the
 * provider-specific mocks and route imports live here.
 */
import { vi, it, expect } from 'vitest';
import {
  mockRouteWiringFactories,
  describeRouteWiringContract,
} from '@/src/lib/kernel/__tests__/brain-connector-contract';

const sealApiKey = vi.fn();
const keySealed = vi.fn();
const keyPending = vi.fn();
const revokeApiKey = vi.fn();
const findAsset = vi.fn();
const readScopes = vi.fn();
const publish = vi.fn();

const { tokenOpts, disconnectOpts, manifestOpts } = mockRouteWiringFactories();

vi.doMock('@/src/lib/zai/connector', () => ({
  sealApiKey,
  zaiKeySealed: keySealed,
  revokeApiKey,
}));

vi.doMock('@/src/lib/zai/scope-manifest', () => ({
  findZaiManifestAsset: findAsset,
  readActiveZaiScopes: readScopes,
  publishZaiScopeManifest: publish,
  zaiKeySealed: keySealed,
  zaiKeyPending: keyPending,
  VALID_ZAI_SCOPES: ['zai:infer'],
}));

// Importing evaluates each route module → each factory records its options.
const tokenRoute = await import('../../../../app/zai/api/token/route');
const disconnectRoute = await import('../../../../app/zai/api/disconnect/route');
const manifestRoute = await import('../../../../app/zai/api/scope-manifest/route');

// Direct, literal assertion (rather than only delegating to the shared
// contract below) so this file itself is recognized as containing test
// cases. See the module doc comment on brain-connector-contract.ts. The
// shared contract only checks manifestRoute.GET; this pins that the
// connector's own app/zai/api/scope-manifest/route.ts file actually
// re-exports POST and OPTIONS too, which is specific to this file's own
// destructuring — not the factory the contract already covers.
it('re-exports POST and OPTIONS from the scope-manifest route, not just GET', () => {
  expect((manifestRoute as Record<string, unknown>).POST).toBeDefined();
  expect((manifestRoute as Record<string, unknown>).OPTIONS).toBeDefined();
});

describeRouteWiringContract({
  label: 'Z.ai',
  inferScope: 'zai:infer',
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
