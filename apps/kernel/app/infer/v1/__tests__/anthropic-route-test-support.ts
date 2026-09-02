/**
 * Shared `vi.mock` boilerplate + fixtures for the `POST /infer/v1/messages`,
 * `POST /infer/v1/messages/count_tokens`, and `GET /infer/v1/models` route
 * test suites (#1959).
 *
 * All three routes share the same rate-limit/auth/CORS/brain-resolution/
 * spend-cap/error-mapping gates (via `anthropic-messages/route-support.ts`),
 * so their tests share this one mock/fixture module rather than each
 * declaring the same ~40 lines of `vi.mock(...)` factories independently —
 * mirroring the precedent `app/profile/api/profile/[id]/__tests__/
 * route-test-support.ts` set for the Ask Me `/query`/`/stream` suites
 * (#1956), and avoiding the exact cross-file duplication SonarCloud flagged
 * there.
 *
 * Vitest hoists `vi.mock`/`vi.hoisted` calls to the top of whichever module
 * they're written in, and ES module imports execute in order, so importing
 * this module (before the route under test) registers every mock here
 * exactly as if it were declared inline in the test file itself.
 */
import { vi } from 'vitest';

const hoistedMocks = vi.hoisted(() => ({
  mockResolveInferenceAuth: vi.fn(),
  mockRateLimit: vi.fn(),
  mockResolveBrain: vi.fn(),
  mockReadConnectorRegistration: vi.fn(),
  mockEnforceSpendCap: vi.fn(),
}));
const { mockResolveInferenceAuth, mockRateLimit, mockResolveBrain, mockReadConnectorRegistration, mockEnforceSpendCap } =
  hoistedMocks;
export { mockResolveInferenceAuth, mockRateLimit, mockResolveBrain, mockReadConnectorRegistration, mockEnforceSpendCap };

vi.mock('@/src/lib/inference/auth', () => ({
  resolveInferenceAuth: mockResolveInferenceAuth,
}));

vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({ 'Access-Control-Allow-Origin': 'https://agent.example' }),
  corsOptions: () => new Response(null, { status: 204 }),
}));

vi.mock('@imajin/config', () => ({
  rateLimit: mockRateLimit,
  getClientIP: () => '203.0.113.7',
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

// `brain.ts` pulls in a real drizzle client + connector modules purely to
// build error messages — see `brain-errors-test-support.ts` for the shared
// shape every route/adapter test that mocks this module reuses.
vi.mock('@/src/lib/inference/brain', async () => {
  const { createFakeBrainErrorClasses } = await import('@/src/lib/inference/__tests__/brain-errors-test-support');
  return { resolveBrain: mockResolveBrain, ...createFakeBrainErrorClasses() };
});

vi.mock('@/src/lib/kernel/connector-registry-store', () => ({
  connectorRegistryId: (ownerDid: string, provider: string) => `conn_${ownerDid}_${provider}`,
  readConnectorRegistration: mockReadConnectorRegistration,
}));

// Fully replaced (no `importActual`) — the real module imports `@/src/db`,
// which throws at import time without a live DATABASE_URL. `enforceSpendCap`
// is always the shared spy: only `messages/route.test.ts` calls it in a
// route under test (`count_tokens`/`models` never enforce a spend cap), but
// one shared mock registration avoids two conflicting `vi.mock` calls for
// the same module across files that import this support module.
vi.mock('@/src/lib/inference/spend-cap', async () => {
  const { createFakeSpendCapClasses } = await import('@/src/lib/inference/__tests__/brain-errors-test-support');
  return { ...createFakeSpendCapClasses(), enforceSpendCap: mockEnforceSpendCap };
});

// `anthropic-messages/forward.ts` imports this for `recordInferenceUsage`,
// which imports the real `@/src/db` drizzle client. Mocked here so each
// route test's `vi.importActual` on `forward.ts` (to keep its real
// `applySealedModel`/URL-building while overriding just the one exported
// forwarder under test) never needs a live DATABASE_URL.
vi.mock('@/src/lib/inference/usage-ledger', () => ({
  recordInferenceUsage: vi.fn().mockResolvedValue(undefined),
}));

// ─── Shared fixtures ─────────────────────────────────────────────────────────

export const OWNER_DID = 'did:imajin:supplier';
export const APP_DID = 'did:imajin:nanoclaw-app';

export const ANTHROPIC_BRAIN = {
  connector: 'anthropic' as const,
  credentialDid: OWNER_DID,
  provider: 'anthropic' as const,
  modelId: 'claude-opus-4-6',
  apiKey: 'sk-ant-sealed-secret',
};

/** Common `beforeEach` reset every route suite in this family shares. */
export function resetAnthropicRouteMocks(): void {
  vi.clearAllMocks();
  mockRateLimit.mockReturnValue({ limited: false });
  mockResolveInferenceAuth.mockResolvedValue({ ok: true, context: { ownerDid: OWNER_DID, appDid: APP_DID } });
  mockResolveBrain.mockResolvedValue(ANTHROPIC_BRAIN);
  mockReadConnectorRegistration.mockResolvedValue(undefined);
  mockEnforceSpendCap.mockResolvedValue(undefined);
}
