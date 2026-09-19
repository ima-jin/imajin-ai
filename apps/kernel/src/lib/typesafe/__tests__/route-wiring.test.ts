/**
 * TypeSafe.ai route wiring tests (#2197).
 *
 * The wiring contract, and the mock-setup boilerplate for the two
 * connector-agnostic route factories, are shared with every other
 * token-paste connector -- see `mockRouteWiringFactories` and
 * `describeRouteWiringContract` in
 * `src/lib/kernel/__tests__/brain-connector-contract.ts`. Only the
 * provider-specific mocks and route imports live here. `models` and
 * `decide` are bespoke routes (not built on these shared factories) and are
 * covered by their own route tests instead.
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

vi.doMock('@/src/lib/typesafe/connector', () => ({
  sealApiKey,
  typesafeKeySealed: keySealed,
  revokeApiKey,
}));

vi.doMock('@/src/lib/typesafe/scope-manifest', () => ({
  findTypesafeManifestAsset: findAsset,
  readActiveTypesafeScopes: readScopes,
  publishTypesafeScopeManifest: publish,
  typesafeKeySealed: keySealed,
  typesafeKeyPending: keyPending,
  VALID_TYPESAFE_SCOPES: ['typesafe:decide'],
}));

// Importing evaluates each route module -> each factory records its options.
const connectRoute = await import('../../../../app/typesafe/api/connect/route');
const disconnectRoute = await import('../../../../app/typesafe/api/disconnect/route');
const typesafeManifestRoute = await import('../../../../app/typesafe/api/scope-manifest/route');

// Direct, literal it() with a literal expect() on the helper's return value
// (see expectScopeManifestRouteExportsPostAndOptions's doc comment) so Sonar
// S2699 recognizes this file as containing a real assertion.
it('re-exports POST and OPTIONS from the scope-manifest route, not just GET', () => {
  expect(expectScopeManifestRouteExportsPostAndOptions(typesafeManifestRoute as Record<string, unknown>)).toBe(true);
});

describeRouteWiringContract({
  label: 'TypeSafe.ai',
  inferScope: 'typesafe:decide',
  tokenOpts,
  disconnectOpts,
  manifestOpts,
  tokenRoute: connectRoute as Record<string, unknown>,
  disconnectRoute: disconnectRoute as Record<string, unknown>,
  manifestRoute: typesafeManifestRoute as Record<string, unknown>,
  sealApiKey,
  keySealed,
  keyPending,
  revokeApiKey,
  findAsset,
  readScopes,
  publish,
});
