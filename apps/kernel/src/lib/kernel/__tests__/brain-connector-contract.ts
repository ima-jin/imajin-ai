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
import { VaultDelegationError } from '@/src/lib/vault/errors';

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
  /**
   * The connector's exported base-URL constant, when it has one. Gemini and
   * Anthropic do not export a shared endpoint constant the way the
   * OpenAI-compatible providers (OpenAI, xAI) do, so this — and
   * `expectedBaseUrl` — are omitted for them and the endpoint test is skipped.
   */
  baseUrl?: string;
  /** The literal endpoint that constant is expected to hold. */
  expectedBaseUrl?: string;
  vaultField: (ownerDid: string) => string;
  capturedOpts: { current: Record<string, unknown> | null };
  loadCredentials: Mock;
  /**
   * Only providers with a model picker (#1773) have a grant-skipping read.
   * Anthropic has none, so this — and `loadProviderSealedCredentials` — are
   * omitted for it and that test is skipped.
   */
  loadSealedCredentials?: Mock;
  loadProviderCredentials: (ownerDid: string) => Promise<unknown>;
  loadProviderSealedCredentials?: (ownerDid: string) => Promise<unknown>;
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
     * pointing somewhere retired. Only OpenAI-compatible providers (OpenAI,
     * xAI) export this constant — Gemini and Anthropic omit `baseUrl`, so
     * this test is skipped for them.
     */
    if (baseUrl !== undefined) {
      it(`exports one ${label} endpoint for every caller to share`, () => {
        expect(baseUrl).toBe(expectedBaseUrl);
      });
    }
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
     * quietly become this one. Only providers with a model picker have this
     * read — Anthropic has none, so this test is skipped for it.
     */
    if (loadSealedCredentials !== undefined && loadProviderSealedCredentials !== undefined) {
      it('reserves the grant-skipping read for the model picker', async () => {
        loadSealedCredentials.mockResolvedValueOnce({ apiKey: sampleApiKey });

        await loadProviderSealedCredentials(OWNER);

        expect(loadSealedCredentials).toHaveBeenCalledWith(OWNER);
        expect(loadSealedCredentials).not.toHaveBeenCalledWith(OWNER, inferScope);
      });
    }
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
      expect(opts.isOnConsent('not-this-connector:infer')).toBe(false);
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

// ── Vault/DB-backed credential lifecycle (pre-#1621 style connectors) ──────
//
// Gemini (#1432) and Anthropic (#1621) predate `createConnectorTokenPaste`
// being extracted into its own factory — their `connector.test.ts` files
// mock `@/src/lib/vault` and `@/src/db` directly and exercise the REAL
// `resolveActiveGrant` / `sealApiKey` / `loadCredentials` / `requireGrantAndKey`
// / `keySealed` / `keyPending` / `revokeApiKey` returned by the factory,
// rather than mocking the factory itself the way `mockConnectorTokenPasteFactory`
// does for OpenAI/xAI. That is exactly what makes the two files near-identical
// (same mocks, same describe/it tree, differing only in id/scope/field
// literals) — this contract declares that tree once.

export interface ConnectorVaultAndDbMocks {
  sealMock: Mock;
  sealV1Mock: Mock;
  loadMock: Mock;
  statusMock: Mock;
  whereMock: Mock;
  revokeVaultGrantsMock: Mock;
  channelLinksRevokeMock: Mock;
}

/**
 * Mock `@/src/lib/vault`, `@/src/db`, and `@imajin/logger` — the seams
 * `createConnectorTokenPaste` itself is built on — via `vi.doMock`. Call this
 * BEFORE dynamically importing the connector module under test, same as
 * `mockConnectorTokenPasteFactory`.
 */
export function mockConnectorVaultAndDb(): ConnectorVaultAndDbMocks {
  const sealMock = vi.fn();
  const sealV1Mock = vi.fn();
  const loadMock = vi.fn();
  const statusMock = vi.fn();
  const whereMock = vi.fn();
  const revokeVaultGrantsMock = vi.fn();
  const channelLinksRevokeMock = vi.fn();

  vi.doMock('@/src/lib/vault', () => ({
    sealAndStore: sealV1Mock,
    sealAndStoreV2: sealMock,
    loadAndUnseal: loadMock,
    vaultFieldStatus: statusMock,
    revokeVaultDelegationGrantsForConnector: revokeVaultGrantsMock,
  }));
  const updateWhere = () => ({ returning: channelLinksRevokeMock });
  const updateSet = () => ({ where: updateWhere });
  vi.doMock('@/src/db', () => ({
    db: {
      select: () => ({ from: () => ({ where: whereMock }) }),
      update: () => ({ set: updateSet }),
    },
    channelLinks: { channel: 'channel', did: 'did', appDid: 'appDid', status: 'status', scopes: 'scopes', id: 'id' },
  }));
  vi.doMock('@imajin/logger', () => ({
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }));

  return { sealMock, sealV1Mock, loadMock, statusMock, whereMock, revokeVaultGrantsMock, channelLinksRevokeMock };
}

export interface ConnectorCredentialLifecycleFixture {
  /** Display name, e.g. `'Gemini'`. Only used in a couple of `it()` titles. */
  label: string;
  /** Lowercase connector id, e.g. `'gemini'`. */
  id: string;
  connectorDid: string;
  inferScope: string;
  vaultField: (ownerDid: string) => string;
  sampleApiKey: string;
  sampleBaseUrl: string;
  sampleModelId: string;
  resolveActiveGrant: (ownerDid: string, scope: string) => Promise<boolean>;
  sealApiKey: (ownerDid: string, apiKey: string, baseUrl?: string, modelId?: string) => Promise<void>;
  loadProviderCredentials: (ownerDid: string) => Promise<{ apiKey: string; baseUrl?: string; modelId?: string } | undefined>;
  requireGrantAndKey: (ownerDid: string, scope: string) => Promise<string>;
  keySealed: (ownerDid: string) => Promise<boolean>;
  keyPending: (ownerDid: string) => Promise<boolean>;
  revokeApiKey: (ownerDid: string) => Promise<boolean>;
  mocks: ConnectorVaultAndDbMocks;
}

/**
 * Pins the REAL behaviour of a token-paste connector built directly against
 * vault/DB mocks: DID stability and vault-field isolation, the grant gate
 * (`resolveActiveGrant`), the v2-vs-v1 custody split in `sealApiKey`, every
 * branch of credential resolution (missing grant, missing key, pending
 * owner approval, corrupt optional fields), the fail-closed
 * `requireGrantAndKey` gate, the `keySealed`/`keyPending` status matrix
 * (#1724/#1521), and `revokeApiKey`'s `channel_links` sweep (#1733).
 *
 * This is the Gemini/Anthropic counterpart to `describeConnectorIdentityContract`
 * — those two predate the `createConnectorTokenPaste` factory extraction and
 * still exercise it end-to-end rather than through a mocked factory, so their
 * contract pins the factory's real behaviour rather than just identity wiring.
 */
export function describeConnectorCredentialLifecycleContract(fixture: ConnectorCredentialLifecycleFixture): void {
  const {
    label, id, connectorDid, inferScope, vaultField, sampleApiKey, sampleBaseUrl, sampleModelId,
    resolveActiveGrant, sealApiKey, loadProviderCredentials, requireGrantAndKey, keySealed, keyPending, revokeApiKey,
    mocks: { sealMock, sealV1Mock, loadMock, statusMock, whereMock, revokeVaultGrantsMock, channelLinksRevokeMock },
  } = fixture;

  function grant(scopes: string[]) {
    whereMock.mockResolvedValue([{ scopes }]);
  }

  function noGrant() {
    whereMock.mockResolvedValue([]);
  }

  beforeEach(() => {
    sealMock.mockReset();
    sealMock.mockResolvedValue(undefined);
    sealV1Mock.mockReset();
    sealV1Mock.mockResolvedValue(undefined);
    loadMock.mockReset();
    loadMock.mockResolvedValue(undefined);
    statusMock.mockReset();
    statusMock.mockResolvedValue('absent');
    whereMock.mockReset();
    revokeVaultGrantsMock.mockReset();
    revokeVaultGrantsMock.mockResolvedValue(0);
    channelLinksRevokeMock.mockReset();
    channelLinksRevokeMock.mockResolvedValue([]);
  });

  describe(`${label} connector identity`, () => {
    it('is stable', () => {
      expect(connectorDid).toBe(`did:imajin:${id}-connector`);
    });

    it('encodes the ownerDid in the field name for per-DID isolation', () => {
      expect(vaultField(OWNER)).toBe(`${id}-api-key:${OWNER}`);
    });

    it('gives different DIDs different fields, so cross-DID reads are structural', () => {
      const fieldA = vaultField('did:imajin:alice');
      const fieldB = vaultField('did:imajin:bob');
      expect(fieldA).not.toBe(fieldB);
      expect(fieldA).toBe(`${id}-api-key:did:imajin:alice`);
      expect(fieldB).toBe(`${id}-api-key:did:imajin:bob`);
    });
  });

  describe('resolveActiveGrant', () => {
    it('is true when an active row includes the required scope', async () => {
      grant([inferScope]);
      expect(await resolveActiveGrant(OWNER, inferScope)).toBe(true);
    });

    it('is false when an active row lacks the required scope', async () => {
      grant(['other:scope']);
      expect(await resolveActiveGrant(OWNER, inferScope)).toBe(false);
    });

    it('is false when there are no rows at all', async () => {
      noGrant();
      expect(await resolveActiveGrant(OWNER, inferScope)).toBe(false);
    });
  });

  describe('sealApiKey', () => {
    it('seals the API key under the per-DID vault field with delegation-grant custody', async () => {
      await sealApiKey(OWNER, sampleApiKey);
      const [field, plaintext] = sealMock.mock.calls[0] as [string, string];
      expect(field).toBe(vaultField(OWNER));
      expect(plaintext).toBe(sampleApiKey);
    });

    /**
     * The endpoint and the model name are neither secret nor
     * authority-bearing, so they are node-sealed (v1) rather than
     * delegation-grant (#1637). Under Tier 1 a v2 write is unreadable until
     * the owner agent approves it, which would mean a model override
     * silently not applying.
     */
    it('seals baseUrl node-sealed (v1), not delegation-grant (#1637)', async () => {
      await sealApiKey(OWNER, sampleApiKey, sampleBaseUrl);
      expect(sealMock).toHaveBeenCalledTimes(1);
      expect(sealV1Mock).toHaveBeenCalledTimes(1);
      expect(sealV1Mock.mock.calls[0]).toEqual([`${id}-base-url:${OWNER}`, sampleBaseUrl]);
    });

    it('seals modelId node-sealed (v1), not delegation-grant (#1637)', async () => {
      await sealApiKey(OWNER, sampleApiKey, undefined, sampleModelId);
      expect(sealMock).toHaveBeenCalledTimes(1);
      expect(sealV1Mock).toHaveBeenCalledTimes(1);
      expect(sealV1Mock.mock.calls[0]).toEqual([`${id}-model-id:${OWNER}`, sampleModelId]);
    });

    it('seals all three, one under v2 custody and two under v1', async () => {
      await sealApiKey(OWNER, sampleApiKey, sampleBaseUrl, sampleModelId);
      expect(sealMock).toHaveBeenCalledTimes(1);
      expect(sealV1Mock).toHaveBeenCalledTimes(2);
    });

    it('does not seal baseUrl or modelId when omitted', async () => {
      await sealApiKey(OWNER, sampleApiKey);
      expect(sealMock).toHaveBeenCalledTimes(1);
      expect(sealV1Mock).not.toHaveBeenCalled();
    });
  });

  describe('credential resolution', () => {
    it('returns undefined without an active grant and never touches the vault', async () => {
      noGrant();
      expect(await loadProviderCredentials(OWNER)).toBeUndefined();
      expect(loadMock).not.toHaveBeenCalled();
    });

    it('returns undefined when granted but no key is sealed', async () => {
      grant([inferScope]);
      loadMock.mockResolvedValue(undefined);
      expect(await loadProviderCredentials(OWNER)).toBeUndefined();
    });

    it('returns the key alone when no overrides are sealed', async () => {
      grant([inferScope]);
      loadMock.mockResolvedValueOnce(sampleApiKey).mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);
      const result = await loadProviderCredentials(OWNER);
      expect(result?.apiKey).toBe(sampleApiKey);
      expect(result?.baseUrl).toBeUndefined();
      expect(result?.modelId).toBeUndefined();
    });

    it('returns the sealed baseUrl and modelId when present', async () => {
      grant([inferScope]);
      loadMock.mockResolvedValueOnce(sampleApiKey).mockResolvedValueOnce(sampleBaseUrl).mockResolvedValueOnce(sampleModelId);
      expect(await loadProviderCredentials(OWNER)).toEqual({
        apiKey: sampleApiKey, baseUrl: sampleBaseUrl, modelId: sampleModelId,
      });
    });

    /**
     * #1637: this used to throw, which took the whole brain walk down with
     * it — a key awaiting Tier 1 approval meant a healthy sibling provider's
     * key was never tried. `undefined` is the documented answer for "no
     * usable connection".
     */
    it('returns undefined when the key is sealed but awaiting owner approval', async () => {
      grant([inferScope]);
      loadMock.mockRejectedValueOnce(
        new VaultDelegationError('no active grant', { field: vaultField(OWNER), nodeDid: 'did:imajin:node' }),
      );
      await expect(loadProviderCredentials(OWNER)).resolves.toBeUndefined();
    });

    it('still propagates a non-delegation vault failure', async () => {
      grant([inferScope]);
      loadMock.mockRejectedValueOnce(new Error('vault integrity failure'));
      await expect(loadProviderCredentials(OWNER)).rejects.toThrow('vault integrity failure');
    });

    it('degrades an unreadable baseUrl/modelId to "no override" instead of failing', async () => {
      grant([inferScope]);
      loadMock
        .mockResolvedValueOnce(sampleApiKey)
        .mockRejectedValueOnce(
          new VaultDelegationError('no active grant', { field: `${id}-base-url:${OWNER}`, nodeDid: 'did:imajin:node' }),
        )
        .mockRejectedValueOnce(new Error('corrupt entry'));
      await expect(loadProviderCredentials(OWNER)).resolves.toEqual({ apiKey: sampleApiKey });
    });
  });

  describe('requireGrantAndKey (fail-closed gate)', () => {
    it(`throws ${id}_no_grant when there is no active grant`, async () => {
      noGrant();
      await expect(requireGrantAndKey(OWNER, inferScope)).rejects.toThrow(new RegExp(`${id}_no_grant`));
    });

    it(`throws ${id}_no_key when grant exists but no key is sealed`, async () => {
      grant([inferScope]);
      loadMock.mockResolvedValue(undefined);
      await expect(requireGrantAndKey(OWNER, inferScope)).rejects.toThrow(new RegExp(`${id}_no_key`));
    });

    it('returns the key when both grant and key are present', async () => {
      grant([inferScope]);
      loadMock.mockResolvedValue(sampleApiKey);
      expect(await requireGrantAndKey(OWNER, inferScope)).toBe(sampleApiKey);
    });

    it(`throws ${id}_credential_pending when the key is sealed but no grant has arrived (#1521)`, async () => {
      grant([inferScope]);
      loadMock.mockRejectedValue(
        new VaultDelegationError('no active grant', { field: vaultField(OWNER), nodeDid: 'did:imajin:node' }),
      );
      await expect(requireGrantAndKey(OWNER, inferScope)).rejects.toThrow(new RegExp(`${id}_credential_pending`));
    });

    it('never names the key in a failure message', async () => {
      noGrant();
      const err = await requireGrantAndKey(OWNER, inferScope).catch((e: unknown) => e as Error);
      expect(err.message).not.toContain(sampleApiKey);
    });
  });

  // #1724: `keySealed` used to delegate to `vaultFieldExists`, which only
  // checks that the vault entry exists — not whether an active grant covers
  // it. `revokeApiKey` (disconnect) leaves the entry in place and only
  // revokes the grant, so that reported a disconnected key as sealed
  // forever. It now delegates to `vaultFieldStatus`, which filters
  // `WHERE status = 'active'`.
  describe('keySealed (#1724)', () => {
    it('delegates to vaultFieldStatus with the per-DID field', async () => {
      statusMock.mockResolvedValue('ready');
      expect(await keySealed(OWNER)).toBe(true);
      expect(statusMock).toHaveBeenCalledWith(vaultField(OWNER));
    });

    it('returns false when no key is sealed', async () => {
      statusMock.mockResolvedValue('absent');
      expect(await keySealed(OWNER)).toBe(false);
    });

    it('returns false once the grant is revoked, even though the vault entry still exists', async () => {
      // A revoked grant reports 'pending-grant' (no active grant covers the
      // entry), not 'ready' — this is the exact disconnect state from #1724.
      statusMock.mockResolvedValue('pending-grant');
      expect(await keySealed(OWNER)).toBe(false);
    });

    it('returns false for an unverifiable entry', async () => {
      statusMock.mockResolvedValue('unverifiable');
      expect(await keySealed(OWNER)).toBe(false);
    });
  });

  describe('keyPending (#1521)', () => {
    it('is true when the field status is pending-grant', async () => {
      statusMock.mockResolvedValue('pending-grant');
      expect(await keyPending(OWNER)).toBe(true);
      expect(statusMock).toHaveBeenCalledWith(vaultField(OWNER));
    });

    it('is false when the field is ready, absent, or unverifiable', async () => {
      for (const status of ['ready', 'absent', 'unverifiable']) {
        statusMock.mockResolvedValue(status);
        expect(await keyPending(OWNER)).toBe(false);
      }
    });
  });

  describe('revokeApiKey (#1720)', () => {
    it('delegates to revokeVaultDelegationGrantsForConnector with the connector id and owner DID', async () => {
      revokeVaultGrantsMock.mockResolvedValue(1);
      await revokeApiKey(OWNER);
      expect(revokeVaultGrantsMock).toHaveBeenCalledWith(id, OWNER);
    });

    it('returns true when at least one grant was revoked', async () => {
      revokeVaultGrantsMock.mockResolvedValue(1);
      expect(await revokeApiKey(OWNER)).toBe(true);
    });

    it('returns false when no active grant existed', async () => {
      revokeVaultGrantsMock.mockResolvedValue(0);
      expect(await revokeApiKey(OWNER)).toBe(false);
    });

    // #1733: revoking only the vault grant left every previously granted
    // channel_links scope reporting active forever. `revokeApiKey` now also
    // sweeps active channel_links rows for this connector + DID.
    it('also revokes active channel_links rows, even with nothing left in the vault to revoke', async () => {
      revokeVaultGrantsMock.mockResolvedValue(0);
      channelLinksRevokeMock.mockResolvedValue([{ id: 'clink_1' }]);
      expect(await revokeApiKey(OWNER)).toBe(true);
    });

    it('returns false when neither the vault grant nor any channel_links row was active', async () => {
      revokeVaultGrantsMock.mockResolvedValue(0);
      channelLinksRevokeMock.mockResolvedValue([]);
      expect(await revokeApiKey(OWNER)).toBe(false);
    });
  });
}
