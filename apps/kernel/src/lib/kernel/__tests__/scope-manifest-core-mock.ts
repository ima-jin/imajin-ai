import { vi } from 'vitest';

/**
 * Shared `vi.mock('@/src/lib/kernel/scope-manifest-core', ...)` factory
 * (#2144 dedup). Every connector's own scope-manifest wrapper test (gcp,
 * quickbooks, discord, github, mcp, google, ...) mocks this module with the
 * identical five-function literal, differing only in cosmetic placeholder
 * values — exactly the kind of same-shape-different-literal block SonarCloud's
 * duplication detector flags once enough connectors pile up (see
 * `brainInferScope` / `brainConnectorEntry` in the production code for the
 * same reasoning applied to non-test duplication).
 *
 * Usage — call it from inside a small arrow-function factory (do NOT pass
 * the imported reference directly as vi.mock's second argument: vitest
 * hoists the `vi.mock(...)` call above the `import` line, so reading the
 * bare imported identifier at that point throws a TDZ ReferenceError; a
 * wrapping arrow function defers the read until vi.mock actually invokes it,
 * by which time the import has resolved):
 *
 *   vi.mock('@/src/lib/kernel/scope-manifest-core', () => scopeManifestCoreMockFactory());
 *   import {
 *     buildConnectorManifestContent, findConnectorManifestAsset,
 *     readActiveConnectorScopes, syncConnectorConsentGrants,
 *     publishConnectorScopeManifest,
 *   } from '@/src/lib/kernel/scope-manifest-core';
 *   // assert with vi.mocked(buildConnectorManifestContent) etc.
 */
export function scopeManifestCoreMockFactory() {
  return {
    buildConnectorManifestContent: vi.fn(() => 'yaml-content'),
    findConnectorManifestAsset: vi.fn(async () => null),
    readActiveConnectorScopes: vi.fn(async () => []),
    syncConnectorConsentGrants: vi.fn(async () => undefined),
    publishConnectorScopeManifest: vi.fn(async () => 'asset_test'),
  };
}
