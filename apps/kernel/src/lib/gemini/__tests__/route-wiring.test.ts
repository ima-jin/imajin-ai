/**
 * Gemini route wiring tests (#1432 token route/#1720 disconnect/#1521 scope-manifest).
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

vi.doMock('@/src/lib/gemini/connector', () => ({
  sealApiKey,
  geminiKeySealed: keySealed,
  revokeApiKey,
}));

vi.doMock('@/src/lib/gemini/scope-manifest', () => ({
  findGeminiManifestAsset: findAsset,
  readActiveGeminiScopes: readScopes,
  publishGeminiScopeManifest: publish,
  geminiKeySealed: keySealed,
  geminiKeyPending: keyPending,
  VALID_GEMINI_SCOPES: ['gemini:infer'],
}));

// Importing evaluates each route module → each factory records its options.
const tokenRoute = await import('../../../../app/gemini/api/token/route');
const disconnectRoute = await import('../../../../app/gemini/api/disconnect/route');
const manifestRoute = await import('../../../../app/gemini/api/scope-manifest/route');

describeRouteWiringContract({
  label: 'Gemini',
  inferScope: 'gemini:infer',
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
