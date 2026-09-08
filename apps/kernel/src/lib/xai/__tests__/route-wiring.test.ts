/**
 * xAI route wiring tests (#1924).
 *
 * The wiring contract, and the mock-setup boilerplate for the two
 * connector-agnostic route factories, are shared with every other
 * token-paste connector — see `mockRouteWiringFactories` and
 * `describeRouteWiringContract` in
 * `src/lib/kernel/__tests__/brain-connector-contract.ts` (#1927). Only the
 * provider-specific mocks and route imports live here.
 */
import { vi, it, expect } from 'vitest';
import {
  mockRouteWiringFactories,
  describeRouteWiringContract,
  expectScopeManifestRouteExportsPostAndOptions,
} from '@/src/lib/kernel/__tests__/brain-connector-contract';

const sealApiKey = vi.fn();
const keySealed = vi.fn();
const keyPending = vi.fn();
const revokeApiKey = vi.fn();
const findAsset = vi.fn();
const readScopes = vi.fn();
const publish = vi.fn();

const { tokenOpts, disconnectOpts, manifestOpts } = mockRouteWiringFactories();

vi.doMock('@/src/lib/xai/connector', () => ({
  sealApiKey,
  xaiKeySealed: keySealed,
  revokeApiKey,
}));

vi.doMock('@/src/lib/xai/scope-manifest', () => ({
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
const xaiManifestRoute = await import('../../../../app/xai/api/scope-manifest/route');

// Direct, literal it() with a literal expect() on the helper's return value
// (see expectScopeManifestRouteExportsPostAndOptions's doc comment) so Sonar
// S2699 recognizes this file as containing a real assertion.
it('re-exports POST and OPTIONS from the scope-manifest route, not just GET', () => {
  expect(expectScopeManifestRouteExportsPostAndOptions(xaiManifestRoute as Record<string, unknown>)).toBe(true);
});

describeRouteWiringContract({
  label: 'xAI',
  inferScope: 'xai:infer',
  tokenOpts,
  disconnectOpts,
  manifestOpts,
  tokenRoute: tokenRoute as Record<string, unknown>,
  disconnectRoute: disconnectRoute as Record<string, unknown>,
  manifestRoute: xaiManifestRoute as Record<string, unknown>,
  sealApiKey,
  keySealed,
  keyPending,
  revokeApiKey,
  findAsset,
  readScopes,
  publish,
});
