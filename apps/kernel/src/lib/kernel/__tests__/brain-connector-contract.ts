/**
 * Shared parameterized contract tests for token-paste brain connectors
 * (#1927).
 *
 * xAI (#1924) and OpenAI (#1927) pin the exact same three things per
 * connector — identity wiring (`connector.ts`), scope-manifest delegation
 * (`scope-manifest.ts`), and route wiring (`app/{id}/api/**\/route.ts`) — and
 * had been hand-copied down to the `it()` prose AND the `vi.mock(...)`
 * boilerplate that sets each contract up. Declaring each contract's
 * assertions once here, parameterized on the connector's own mocks and
 * imports, means the next token-paste provider with a scope manifest and
 * routes (#1930, #1931) gets full identity/wiring coverage for the price of
 * one call per contract instead of another full copy of these suites.
 *
 * The `mock*Factory`/`mock*Deps` helpers below share the mock-setup
 * boilerplate itself, which is provider-agnostic. They use `vi.doMock`
 * (unlike `vi.mock`, NOT hoisted) rather than `vi.mock`, because `vi.mock`'s
 * hoisting only reorders calls within the file that contains them — moving it
 * into a shared, imported function would not hoist it above that function's
 * OWN caller's imports. `vi.doMock` intercepts the next dynamic `import()` of
 * the mocked path instead, so every per-connector test file calls the shared
 * setup function first and then `await import('../connector')` (etc.) rather
 * than a static `import` — see `connector-token-paste.test.ts`'s sibling
 * files for the pattern.
 */
import { vi, describe, it, expect, beforeEach, type Mock } from 'vitest';

const OWNER = 'did:imajin:farmer';

// ── Connector identity (connector.ts) ───────────────────────────────────────

export interface ConnectorTokenPasteMockFactory {
  capturedOpts: { current: Record<string, unknown> | null };
  loadCredentials: Mock;
  loadSealedCredentials: Mock;
}

/**
 * Mock `createConnectorTokenPaste` (#1621) and capture the options it was
 * built with, so `describeConnectorIdentityContract` can assert on them.
 * Call this BEFORE dynamically importing the connector module under test —
 * see the module doc comment for why this must be `vi.doMock` + a dynamic
 * import rather than the hoisted `vi.mock`.
 */
export function mockConnectorTokenPasteFactory(): ConnectorTokenPasteMockFactory {
  const capturedOpts: { current: Record<string, unknown> | null } = { current: null };
  const factoryStub: Record<string, unknown> = {};
  const loadCredentials = vi.fn();
  const loadSealedCredentials = vi.fn();

  vi.doMock('@/src/lib/kernel/connector-token-paste', () => ({
    createConnectorTokenPaste: vi.fn((opts: Record<string, unknown>) => {
      capturedOpts.current = opts;
      Object.assign(factoryStub, {
        vaultField: (did: string) => `${opts.id as string}-api-key:${did}`,
        sealApiKey: vi.fn(),
        resolveActiveGrant: vi.fn(),
        requireGrantAndKey: vi.fn(),
        keySealed: vi.fn(),
        keyPending: vi.fn(),
        revokeApiKey: vi.fn(),
        setModelId: vi.fn(),
        loadCredentials,
        loadSealedCredentials,
      });
      return factoryStub;
    }),
  }));

  return { capturedOpts, loadCredentials, loadSealedCredentials };
}

export interface ConnectorIdentityContractFixture {
  /** Display name used in owner-facing prose, e.g. `'OpenAI'`. */
  label: string;
  /** Lowercase connector id, e.g. `'openai'`. */
  id: string;
  connectorDid: string;
  channel: string;
  inferScope: string;
  /** The connector's exported base-URL constant. */
  baseUrl: string;
  /** The literal endpoint that constant is expected to hold. */
  expectedBaseUrl: string;
  vaultField: (ownerDid: string) => string;
  capturedOpts: { current: Record<string, unknown> | null };
  loadCredentials: Mock;
  loadSealedCredentials: Mock;
  loadProviderCredentials: (ownerDid: string) => Promise<unknown>;
  loadProviderSealedCredentials: (ownerDid: string) => Promise<unknown>;
  /** A believable sealed-key value; never asserted, just needs to resolve. */
  sampleApiKey: string;
}

/**
 * Pins connector IDENTITY: the connector id (which becomes the vault field
 * prefix), the channel and app DID the grant gate matches on, the scope spent
 * at call time, and the fact that the grant-skipping read is reserved for the
 * model picker. The custody mechanics themselves are the token-paste
 * factory's, and are covered once in
 * `src/lib/kernel/__tests__/connector-token-paste.test.ts` — re-testing them
 * per provider would test the factory N times and the connector zero.
 *
 * Getting any of the identity fields wrong is silent: the key seals fine and
 * inference just never resolves, or — worse — resolves against another
 * provider's field.
 */
export function describeConnectorIdentityContract(fixture: ConnectorIdentityContractFixture): void {
  const {
    label, id, connectorDid, channel, inferScope, baseUrl, expectedBaseUrl, vaultField,
    capturedOpts, loadCredentials, loadSealedCredentials,
    loadProviderCredentials, loadProviderSealedCredentials, sampleApiKey,
  } = fixture;

  describe(`${label} connector identity`, () => {
    it('declares the DID, channel and scope the grant gate matches on', () => {
      expect(connectorDid).toBe(`did:imajin:${id}-connector`);
      expect(channel).toBe(id);
      expect(inferScope).toBe(`${id}:infer`);
    });

    it('builds the factory with the id that becomes the vault field prefix', () => {
      expect(capturedOpts.current).toMatchObject({ id, displayName: label, connectorDid, channel });
    });

    it('isolates the sealed key per DID, and away from the other brains', () => {
      expect(vaultField(OWNER)).toBe(`${id}-api-key:${OWNER}`);
      expect(vaultField(OWNER)).not.toBe(`gemini-api-key:${OWNER}`);
      expect(vaultField('did:imajin:other')).not.toBe(vaultField(OWNER));
    });

    /**
     * The brain entry's `defaultBaseUrl` and the model-picker route both read
     * this. Two copies of a provider endpoint is how one of them ends up
     * pointing somewhere retired.
     */
    it(`exports one ${label} endpoint for every caller to share`, () => {
      expect(baseUrl).toBe(expectedBaseUrl);
    });
  });

  describe('credential resolution', () => {
    it(`spends the key only behind an active ${inferScope} grant`, async () => {
      loadCredentials.mockResolvedValueOnce({ apiKey: sampleApiKey });

      await loadProviderCredentials(OWNER);

      expect(loadCredentials).toHaveBeenCalledWith(OWNER, inferScope);
    });

    /**
     * #1773: the picker asks "what can the owner's own key do?", which the
     * owner asks before the grant step exists. It must NOT be reachable
     * through the grant-checked path, and the grant-checked path must not
     * quietly become this one.
     */
    it('reserves the grant-skipping read for the model picker', async () => {
      loadSealedCredentials.mockResolvedValueOnce({ apiKey: sampleApiKey });

      await loadProviderSealedCredentials(OWNER);

      expect(loadSealedCredentials).toHaveBeenCalledWith(OWNER);
      expect(loadSealedCredentials).not.toHaveBeenCalledWith(OWNER, inferScope);
    });
  });
}

// ── Scope-manifest delegation (scope-manifest.ts) ───────────────────────────

export interface ScopeManifestContractFixture {
  label: string;
  id: string;
  connectorDid: string;
  channel: string;
  inferScope: string;
  filename: string;
  core: {
    buildConnectorManifestContent: Mock;
    findConnectorManifestAsset: Mock;
    readActiveConnectorScopes: Mock;
    syncConnectorConsentGrants: Mock;
    publishConnectorScopeManifest: Mock;
  };
  scopeDescriptors: Record<string, unknown>;
  validScopes: readonly string[];
  buildManifestContent: (scopes: readonly string[]) => string;
  findManifestAsset: (ownerDid: string) => Promise<unknown>;
  readActiveScopes: (ownerDid: string) => Promise<string[]>;
  syncConsentGrants: (ownerDid: string, manifestAssetId: string, scopes: readonly string[]) => Promise<void>;
  publishScopeManifest: (ownerDid: string, scopes: readonly string[]) => Promise<string>;
}

/**
 * Pins that the wrapper delegates every scope-manifest-core call under the
 * connector's own identity. The wrapper owns nothing but identity, so
 * identity is what is pinned: a wrong DID here does not fail — it publishes a
 * manifest, writes consent rows, and projects channel_links under some OTHER
 * connector, which then silently satisfies (or fails) that connector's grant
 * gate instead.
 *
 * The descriptor projection itself is covered by the #1253 drift guard in
 * `src/lib/kernel/__tests__/scope-vocabulary-projection.test.ts`.
 */
export function describeScopeManifestIdentityContract(fixture: ScopeManifestContractFixture): void {
  const {
    label, id, connectorDid, channel, inferScope, filename, core, scopeDescriptors, validScopes,
    buildManifestContent, findManifestAsset, readActiveScopes, syncConsentGrants, publishScopeManifest,
  } = fixture;

  beforeEach(() => {
    for (const fn of Object.values(core)) fn.mockClear();
  });

  describe('derived scope registry', () => {
    it('accepts exactly the scopes the vocabulary gives this connector', () => {
      expect(validScopes).toEqual([inferScope]);
      expect(Object.keys(scopeDescriptors)).toEqual([inferScope]);
    });
  });

  describe(`every delegation carries the ${label} identity`, () => {
    it(`builds manifest content for the ${id} connector and channel`, () => {
      buildManifestContent([inferScope]);

      expect(core.buildConnectorManifestContent).toHaveBeenCalledWith(
        connectorDid, channel, scopeDescriptors, [inferScope],
      );
    });

    it(`looks the manifest asset up by the ${id} connector DID`, async () => {
      await findManifestAsset(OWNER);

      expect(core.findConnectorManifestAsset).toHaveBeenCalledWith(OWNER, connectorDid);
    });

    it(`reads active scopes from the ${id} channel + connector DID`, async () => {
      expect(await readActiveScopes(OWNER)).toEqual([inferScope]);
      expect(core.readActiveConnectorScopes).toHaveBeenCalledWith(OWNER, channel, connectorDid);
    });

    it(`syncs consent grants against the ${id} connector DID`, async () => {
      await syncConsentGrants(OWNER, 'asset_1', [inferScope]);

      const [ownerDid, gotConnectorDid, assetId, scopes] = core.syncConnectorConsentGrants.mock.calls[0];
      expect([ownerDid, gotConnectorDid, assetId, scopes]).toEqual([OWNER, connectorDid, 'asset_1', [inferScope]]);
    });

    /**
     * `{id}:infer` is owner-only under the #1196 2×2, so publishing it must
     * record a consent row — the same treatment every other `*:infer` scope
     * gets. `isOnConsent` is passed as a predicate, so it is asserted by
     * calling it rather than by identity.
     */
    it(`publishes under the ${id} identity and records consent for ${inferScope}`, async () => {
      expect(await publishScopeManifest(OWNER, [inferScope])).toBe('asset_1');

      const [opts] = core.publishConnectorScopeManifest.mock.calls[0] as [{
        ownerDid: string;
        connectorDid: string;
        channel: string;
        filename: string;
        isOnConsent: (s: string) => boolean;
      }];
      expect(opts).toMatchObject({ ownerDid: OWNER, connectorDid, channel, filename });
      expect(opts.isOnConsent(inferScope)).toBe(true);
      // Fail-closed: a scope this connector does not own never records consent.
      expect(opts.isOnConsent('gemini:infer')).toBe(false);
    });
  });
}

// ── Route wiring (app/{id}/api/**\/route.ts) ────────────────────────────────

export interface RouteWiringMockFactories {
  tokenOpts: { current: Record<string, unknown> | null };
  disconnectOpts: { current: Record<string, unknown> | null };
  manifestOpts: { current: Record<string, unknown> | null };
}

/**
 * Mock the two connector-agnostic route factories
 * (`createConnectorTokenRoutes` / `createConnectorTokenDisconnectRoute` from
 * `connector-token-route.ts`, and `createConnectorScopeManifestRoute` from
 * `scope-manifest-route.ts`) and capture the options each was built with, so
 * `describeRouteWiringContract` can assert on them. Call this BEFORE
 * dynamically importing the three route modules under test.
 */
export function mockRouteWiringFactories(): RouteWiringMockFactories {
  const tokenOpts: { current: Record<string, unknown> | null } = { current: null };
  const disconnectOpts: { current: Record<string, unknown> | null } = { current: null };
  const manifestOpts: { current: Record<string, unknown> | null } = { current: null };
  const handlers = { GET: vi.fn(), POST: vi.fn(), OPTIONS: vi.fn() };

  vi.doMock('@/src/lib/kernel/connector-token-route', () => ({
    createConnectorTokenRoutes: vi.fn((opts: Record<string, unknown>) => {
      tokenOpts.current = opts;
      return handlers;
    }),
    createConnectorTokenDisconnectRoute: vi.fn((opts: Record<string, unknown>) => {
      disconnectOpts.current = opts;
      return handlers;
    }),
  }));

  vi.doMock('@/src/lib/kernel/scope-manifest-route', () => ({
    createConnectorScopeManifestRoute: vi.fn((opts: Record<string, unknown>) => {
      manifestOpts.current = opts;
      return handlers;
    }),
  }));

  return { tokenOpts, disconnectOpts, manifestOpts };
}

export interface RouteWiringContractFixture {
  label: string;
  inferScope: string;
  tokenOpts: { current: Record<string, unknown> | null };
  disconnectOpts: { current: Record<string, unknown> | null };
  manifestOpts: { current: Record<string, unknown> | null };
  tokenRoute: Record<string, unknown>;
  disconnectRoute: Record<string, unknown>;
  manifestRoute: Record<string, unknown>;
  sealApiKey: Mock;
  keySealed: Mock;
  keyPending: Mock;
  revokeApiKey: Mock;
  findAsset: Mock;
  readScopes: Mock;
  publish: Mock;
}

/**
 * Pins that the token, disconnect and scope-manifest routes are wired to the
 * right connector and nothing else. These routes are pure wiring over shared
 * factories, so the only thing that CAN be wrong is which connector they are
 * bound to — and that failure is silent: a crossed wire seals one provider's
 * key into another provider's vault field, or disconnects the wrong
 * credential. Factory behaviour itself is covered in `src/lib/kernel/__tests__/`.
 */
export function describeRouteWiringContract(fixture: RouteWiringContractFixture): void {
  const {
    label, inferScope, tokenOpts, disconnectOpts, manifestOpts,
    tokenRoute, disconnectRoute, manifestRoute,
    sealApiKey, keySealed, keyPending, revokeApiKey, findAsset, readScopes, publish,
  } = fixture;

  beforeEach(() => {
    keySealed.mockReset();
    keyPending.mockReset();
  });

  describe('token route', () => {
    it(`seals through the ${label} connector, and nothing else`, () => {
      expect(tokenOpts.current).toMatchObject({ name: label });
      expect(tokenOpts.current?.sealApiKey).toBe(sealApiKey);
      expect(tokenOpts.current?.keySealed).toBe(keySealed);
    });

    it('exports the full credential lifecycle', () => {
      for (const method of ['GET', 'POST', 'OPTIONS'] as const) {
        expect(tokenRoute[method]).toBeDefined();
      }
    });
  });

  describe('disconnect route', () => {
    it(`revokes the ${label} grant`, () => {
      expect(disconnectOpts.current).toMatchObject({ name: label });
      expect(disconnectOpts.current?.revokeApiKey).toBe(revokeApiKey);
    });

    /**
     * No GET: disconnect is a state change, and a readable disconnect
     * endpoint is one CSRF-shaped mistake away from being triggered by a link.
     */
    it('exposes POST and OPTIONS only', () => {
      expect(disconnectRoute.POST).toBeDefined();
      expect(disconnectRoute.OPTIONS).toBeDefined();
      expect(disconnectRoute.GET).toBeUndefined();
    });
  });

  describe('scope-manifest route', () => {
    it(`validates fail-closed against the derived ${label} scope list`, () => {
      expect(manifestOpts.current).toMatchObject({ name: label, validScopes: [inferScope] });
      expect(manifestOpts.current?.publish).toBe(publish);
      expect(manifestOpts.current?.readActiveScopes).toBe(readScopes);
      expect(manifestOpts.current?.findManifestAsset).toBe(findAsset);
      expect(manifestRoute.GET).toBeDefined();
    });

    it.each([
      ['ready', true, false, { keySealed: true, credentialPending: false }],
      ['awaiting owner approval', false, true, { keySealed: false, credentialPending: true }],
    ])('reports the credential as %s', async (_label, sealed, pending, expected) => {
      keySealed.mockResolvedValue(sealed);
      keyPending.mockResolvedValue(pending);

      const getExtraFields = manifestOpts.current?.getExtraFields as (did: string) => Promise<unknown>;

      expect(await getExtraFields(OWNER)).toEqual(expected);
    });
  });
}
