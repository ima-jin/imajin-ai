/**
 * OpenAI route wiring tests (#1927).
 *
 * The wiring contract, and the mock-setup boilerplate for the two
 * connector-agnostic route factories, are shared with every other
 * token-paste connector — see `mockRouteWiringFactories` and
 * `describeRouteWiringContract` in
 * `src/lib/kernel/__tests__/brain-connector-contract.ts`. Only the
 * provider-specific mocks and route imports live here.
 */
import { vi } from 'vitest';
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

vi.doMock('@/src/lib/openai/connector', () => ({
  sealApiKey,
  openaiKeySealed: keySealed,
  revokeApiKey,
}));

vi.doMock('@/src/lib/openai/scope-manifest', () => ({
  findOpenaiManifestAsset: findAsset,
  readActiveOpenaiScopes: readScopes,
  publishOpenaiScopeManifest: publish,
  openaiKeySealed: keySealed,
  openaiKeyPending: keyPending,
  VALID_OPENAI_SCOPES: ['openai:infer'],
}));

// Importing evaluates each route module → each factory records its options.
const tokenRoute = await import('../../../../app/openai/api/token/route');
const disconnectRoute = await import('../../../../app/openai/api/disconnect/route');
const manifestRoute = await import('../../../../app/openai/api/scope-manifest/route');

describeRouteWiringContract({
  label: 'OpenAI',
  inferScope: 'openai:infer',
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
