/**
 * Shared test fixtures/assertions for the #2000 registry migration.
 *
 * apps/coffee, apps/learn, apps/market, and apps/events each build a
 * `.fair` manifest (via `buildFairManifest`, exported alongside this file)
 * using node config sourced from `getNodeSelf()` (`@imajin/config`). Their
 * route-level tests all need to assert the same thing — that
 * `nodeSelf?.field ?? undefined` really flows into the manifest's
 * `node`/`buyer_credit` chain entries — against otherwise-unrelated app
 * packages. Centralizing the fixture + assertion here (deep-imported via a
 * relative path, not part of this package's public `index.ts`/npm surface)
 * keeps those four test suites from reading as near-identical copy-pasted
 * blocks.
 */
import { expect, it } from 'vitest';

export interface FairChainEntry {
  did: string;
  role: string;
  share: number;
}

/** A representative "node self" response as returned by a configured registry. */
export const REGISTRY_NODE_SELF = {
  did: 'did:imajin:jin',
  nodeOperatorDid: 'did:imajin:operator',
  nodeFeeBps: 80,
  buyerCreditBps: 30,
} as const;

export function findChainRole(chain: FairChainEntry[], role: string): FairChainEntry | undefined {
  return chain.find((entry) => entry.role === role);
}

/** Asserts a `.fair` chain reflects REGISTRY_NODE_SELF's fee config. */
export function expectRegistrySourcedShares(chain: FairChainEntry[]): void {
  expect(findChainRole(chain, 'node')).toMatchObject({ did: REGISTRY_NODE_SELF.nodeOperatorDid, share: 0.008 });
  expect(findChainRole(chain, 'buyer_credit')).toMatchObject({ share: 0.003 });
}

/** Asserts a `.fair` chain reflects buildFairManifest's built-in defaults (getNodeSelf() → null). */
export function expectDefaultShares(chain: FairChainEntry[]): void {
  expect(findChainRole(chain, 'node')).toMatchObject({ did: 'NODE_PLACEHOLDER', share: 0.005 });
}

/** A representative forest-group DID used by every getForestScopeConfig() call-site test (#2001). */
export const FOREST_SCOPE_DID = 'did:imajin:forest-group';

/** Asserts a `.fair` chain's `scope` entry reflects the given forest group's fee. */
export function expectForestScopeShare(chain: FairChainEntry[], scopeDid: string, scopeFeeBps: number): void {
  expect(findChainRole(chain, 'scope')).toMatchObject({ did: scopeDid, share: scopeFeeBps / 10000 });
}

// ─── Generic route-test mock factories ─────────────────────────────────────
// These four apps' getNodeSelf() call-site tests otherwise re-declare the
// exact same mock plumbing (a silent logger, a passthrough media resolver,
// the resolveActingDid identity-resolution rule, JSON response helpers, and
// a drizzle insert().values().returning() chain) — sharing it here is what
// keeps those test files from being near-identical copy-paste blocks.

/** Factory for a `vi.mock('@imajin/logger', ...)` that swallows all log calls. */
export function silentLoggerFactory() {
  return { createLogger: () => ({ error: () => {}, info: () => {}, warn: () => {} }) };
}

/** Factory for a `vi.mock('@imajin/media', ...)` that returns refs unchanged. */
export function passthroughMediaRefFactory() {
  return { resolveMediaRef: (ref: string) => ref };
}

/** Shared `resolveActingDid` rule used by every `vi.mock('@imajin/auth', ...)` in these tests. */
export function resolveActingDidMock(identity: { actingFor?: string; actingAs?: string | null; id: string }): string {
  return identity.actingFor ?? identity.actingAs ?? identity.id;
}

/** Shared `jsonResponse`/`errorResponse` implementations for `vi.mock('@/lib/utils', ...)`. */
export function jsonResponseMock(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}
export function errorResponseMock(error: string, status = 400): Response {
  return Response.json({ error }, { status });
}

/** Builds a JSON POST/PATCH Request for a route test. */
export function makeJsonRequest(url: string, method: string, body: Record<string, unknown>): Request {
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Note: a shared "createInsertChainMocks()" factory was considered here too,
// but vi.hoisted() callbacks run before regular imports are live (Vitest
// hoists vi.mock()/vi.hoisted() above the module's import statements), so a
// helper imported from this file cannot be called from inside vi.hoisted().
// Each call site still declares its own three-line insert-chain vi.fn()s;
// only the (non-hoisted, lazily-invoked) piece below is shared.

/** Resolves `.returning()` with whatever was last passed to `.values(...)`, as a single-row array. */
export function echoLastInsertedValue(valuesMock: { mock: { calls: unknown[][] } }) {
  return async () => [valuesMock.mock.calls.at(-1)?.[0]];
}

interface MockLike {
  mockResolvedValue: (value: unknown) => unknown;
}

/**
 * Registers the two `it(...)` cases every getNodeSelf() call-site test needs
 * — success (registry-sourced shares) and fallback (registry unavailable) —
 * against an already-configured `beforeEach`. Callers still own their own
 * mock setup; this only removes the literal, byte-for-byte identical `it`
 * bodies that would otherwise appear in every call site's test file.
 */
export function itDrivesFairManifestFromNodeSelf(config: {
  getNodeSelfMock: MockLike;
  callRoute: () => Promise<Response>;
  getChain: (body: Record<string, unknown>) => FairChainEntry[];
  successStatus?: number;
}): void {
  const successStatus = config.successStatus ?? 201;

  it('uses the registry-sourced fee config in the persisted .fair manifest', async () => {
    config.getNodeSelfMock.mockResolvedValue(REGISTRY_NODE_SELF);

    const res = await config.callRoute();
    expect(res.status).toBe(successStatus);
    expect(config.getNodeSelfMock).toHaveBeenCalled();

    expectRegistrySourcedShares(config.getChain(await res.json()));
  });

  it('falls back to .fair defaults when the registry is unavailable (getNodeSelf() → null)', async () => {
    config.getNodeSelfMock.mockResolvedValue(null);

    const res = await config.callRoute();
    expect(res.status).toBe(successStatus);

    expectDefaultShares(config.getChain(await res.json()));
  });
}

/**
 * Registers the "applies the forest group scope fee" (#2001) `it(...)` case
 * shared by every getForestScopeConfig() call-site test (coffee pages, learn
 * courses, market listings create + patch). Each route resolves/validates
 * the "acting as a scope" caller differently (requireAuth vs requireHardDID
 * identity, and market's PATCH additionally requires the existing listing's
 * sellerDid to match the acting DID) — `arrange()` is where each call site
 * sets up its own route-specific mocks for that; everything else about the
 * call + assertion is identical and lives here.
 */
export function itAppliesForestScopeFee(config: {
  getForestScopeConfigMock: MockLike;
  arrange: () => void;
  callRoute: () => Promise<Response>;
  getChain: (body: Record<string, unknown>) => FairChainEntry[];
  scopeDid?: string;
  scopeFeeBps?: number;
  successStatus?: number;
}): void {
  const scopeDid = config.scopeDid ?? FOREST_SCOPE_DID;
  const scopeFeeBps = config.scopeFeeBps ?? 40;
  const successStatus = config.successStatus ?? 201;

  it('applies the forest group scope fee to the .fair manifest when acting as a scope (#2001)', async () => {
    config.arrange();
    config.getForestScopeConfigMock.mockResolvedValue({ scopeFeeBps });

    const res = await config.callRoute();
    expect(res.status).toBe(successStatus);
    expect(config.getForestScopeConfigMock).toHaveBeenCalledWith(scopeDid);

    expectForestScopeShare(config.getChain(await res.json()), scopeDid, scopeFeeBps);
  });
}
