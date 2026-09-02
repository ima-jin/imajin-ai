/**
 * Shared vi.mock boilerplate + fixtures for the Ask Me `/query` and
 * `/stream` route test suites (#1621, #1956).
 *
 * Both routes share the same auth/trust/brain-resolution gates and the same
 * #1956 usage.incurred emission contract, so their tests share this one
 * mock/fixture module rather than each declaring the same ~130 lines of
 * `vi.mock(...)` factories, fixtures, and the hoisted `NoBrainSealedError`
 * stand-in — which SonarCloud flagged as cross-file duplication when both
 * suites declared it independently.
 *
 * Vitest hoists `vi.mock`/`vi.hoisted` calls to the top of whichever module
 * they're written in, and ES module imports execute in order, so importing
 * this module (before the route under test) registers every mock here
 * exactly as if it were declared inline in the test file itself.
 */
import { vi } from 'vitest';

// `vi.hoisted` values cannot be re-exported directly (the transform refuses
// `export const { ... } = vi.hoisted(...)`), so the hoisted bag stays
// unexported and every mock is re-exported as its own `const` alias below.
const hoistedMocks = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockFindFirst: vi.fn(),
  mockInsertValues: vi.fn(),
  mockResolveBrain: vi.fn(),
  mockGetModel: vi.fn(),
  mockGenerateText: vi.fn(),
  mockStreamText: vi.fn(),
  mockCalculateCost: vi.fn(),
  mockRecordPresenceQueryUsage: vi.fn().mockResolvedValue(undefined),
}));
const {
  mockRequireAuth,
  mockFindFirst,
  mockInsertValues,
  mockResolveBrain,
  mockGetModel,
  mockGenerateText,
  mockStreamText,
  mockCalculateCost,
  mockRecordPresenceQueryUsage,
} = hoistedMocks;
export {
  mockRequireAuth,
  mockFindFirst,
  mockInsertValues,
  mockResolveBrain,
  mockGetModel,
  mockGenerateText,
  mockStreamText,
  mockCalculateCost,
  mockRecordPresenceQueryUsage,
};

vi.mock('@/src/db', () => ({
  db: {
    query: { profiles: { findFirst: mockFindFirst } },
    insert: () => ({ values: mockInsertValues }),
  },
  queryLogs: {},
}));

vi.mock('@imajin/auth', () => ({ requireAuth: mockRequireAuth }));

// Both `generateText` (/query) and `streamText` (/stream) live here so one
// factory covers both routes; each test file only exercises the one it needs.
vi.mock('ai', () => ({ generateText: mockGenerateText, streamText: mockStreamText }));

vi.mock('@imajin/llm', () => ({
  getModel: mockGetModel,
  calculateCost: mockCalculateCost,
  createPresenceTools: () => ({}),
}));

// NoBrainSealedError must be a real class so the routes' `instanceof` branch
// works, and it must be hoisted: vi.mock factories run before module-level
// declarations are initialised.
//
// `failures` mirrors the real shape (#1637): empty means "the owner genuinely
// connected nothing" (409); a non-empty `failures` means the walk was
// degraded by a throwing connector, which maps to 503 instead.
const hoistedNoBrainSealedError = vi.hoisted(() => {
  class NoBrainSealedError extends Error {
    readonly failures: readonly { connector: string; credentialDid: string; cause: string }[];
    constructor(
      ownerDid: string,
      failures: readonly { connector: string; credentialDid: string; cause: string }[] = [],
    ) {
      super(`inference_no_brain: DID ${ownerDid} has no model credential sealed`);
      this.name = 'NoBrainSealedError';
      this.failures = failures;
    }
  }
  return { NoBrainSealedError };
});
const { NoBrainSealedError } = hoistedNoBrainSealedError;
export { NoBrainSealedError };

vi.mock('@/src/lib/inference/brain', () => ({
  resolveBrain: mockResolveBrain,
  NoBrainSealedError,
}));

vi.mock('nanoid', () => ({ nanoid: () => 'query_1' }));
vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@imajin/config', () => ({ buildPublicUrl: () => 'https://imajin.test/profile' }));

vi.mock('@/src/lib/inference/presence-query-usage', () => ({
  recordPresenceQueryUsage: mockRecordPresenceQueryUsage,
  PRESENCE_QUERY_SOURCE: 'presence:query',
}));

// ─── Shared fixtures ─────────────────────────────────────────────────────────

export const OWNER_DID = 'did:imajin:presence-owner';
export const REQUESTER_DID = 'did:imajin:presence-owner'; // self-query: skips the trust hop
export const OWNER_KEY = 'sk-ant-OWNER-SEALED';

export const BRAIN = {
  connector: 'anthropic' as const,
  provider: 'anthropic' as const,
  modelId: 'claude-sonnet-4-20250514',
  apiKey: OWNER_KEY,
};

/** Common `beforeEach` reset both route suites share; route-specific mocks (e.g. `mockGenerateText`/`mockStreamText`) are set by each suite's own `beforeEach` afterward. */
export function resetPresenceRouteMocks(): void {
  vi.clearAllMocks();
  mockRequireAuth.mockResolvedValue({ identity: { id: REQUESTER_DID } });
  mockFindFirst.mockResolvedValue({
    did: OWNER_DID,
    displayName: 'Owner',
    featureToggles: { inference_enabled: true },
  });
  mockResolveBrain.mockResolvedValue(BRAIN);
  mockGetModel.mockReturnValue({});
  mockCalculateCost.mockReturnValue(0);
  mockInsertValues.mockResolvedValue(undefined);
  mockRecordPresenceQueryUsage.mockResolvedValue(undefined);
  // No presence document — the route falls back to a default system prompt.
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
}

/** Stubs the env vars the settle branch (`cost > 0 && !isSelf`) needs to actually attempt a pay call. */
export function stubSettlementEnv(): void {
  vi.stubEnv('PAY_SERVICE_URL', 'https://pay.test');
  vi.stubEnv('PAY_SERVICE_API_KEY', 'pay-key');
  vi.stubEnv('PLATFORM_DID', 'did:imajin:platform');
}

/** fetch sequence for a non-self query that settles successfully: trust check, absent presence doc, then a successful settle call. */
export function makeSettledFetchMock() {
  return vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ connected: true, distance: 1 }) }) // trust
    .mockResolvedValueOnce({ ok: false, json: async () => ({}) }) // presence doc
    .mockResolvedValueOnce({ ok: true, json: async () => ({}) }); // settle
}
