import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Gemini scope-manifest ROUTE wiring test (#1521) ──────────────────────────

const { capturedOpts, mockHandlers, keySealedMock, keyPendingMock } = vi.hoisted(() => ({
  capturedOpts: { current: null as Record<string, unknown> | null },
  mockHandlers: { GET: vi.fn(), POST: vi.fn(), OPTIONS: vi.fn() },
  keySealedMock: vi.fn(),
  keyPendingMock: vi.fn(),
}));

vi.mock('@/src/lib/kernel/scope-manifest-route', () => ({
  createConnectorScopeManifestRoute: vi.fn((opts: Record<string, unknown>) => {
    capturedOpts.current = opts;
    return mockHandlers;
  }),
}));

vi.mock('@/src/lib/gemini/scope-manifest', () => ({
  findGeminiManifestAsset: vi.fn(),
  readActiveGeminiScopes: vi.fn(),
  publishGeminiScopeManifest: vi.fn(),
  geminiKeySealed: keySealedMock,
  geminiKeyPending: keyPendingMock,
  VALID_GEMINI_SCOPES: ['gemini:infer'],
}));

// Import triggers module evaluation → createConnectorScopeManifestRoute is called.
await import('../../../../app/gemini/api/scope-manifest/route');

const OWNER = 'did:imajin:owner';

describe('Gemini scope-manifest route wiring (#1521)', () => {
  beforeEach(() => {
    keySealedMock.mockReset();
    keyPendingMock.mockReset();
  });

  async function getExtraFields(): Promise<Record<string, unknown>> {
    const fn = capturedOpts.current?.getExtraFields as (ownerDid: string) => Promise<Record<string, unknown>>;
    return fn(OWNER);
  }

  it('reports keySealed true and credentialPending false when the key is ready', async () => {
    keySealedMock.mockResolvedValue(true);
    keyPendingMock.mockResolvedValue(false);
    expect(await getExtraFields()).toEqual({ keySealed: true, credentialPending: false });
  });

  it('reports credentialPending true when sealed but awaiting an owner grant', async () => {
    keySealedMock.mockResolvedValue(false);
    keyPendingMock.mockResolvedValue(true);
    expect(await getExtraFields()).toEqual({ keySealed: false, credentialPending: true });
  });
});
