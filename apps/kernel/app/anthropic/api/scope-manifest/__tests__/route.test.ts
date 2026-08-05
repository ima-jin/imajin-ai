/**
 * Anthropic scope-manifest ROUTE wiring test (#1621).
 *
 * The route is pure wiring over the shared factory, so what matters is the
 * wiring itself: bound to the Anthropic scope set, and reporting key status so
 * the connector card can tell "not connected" from "awaiting owner approval".
 * Factory internals have their own tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

vi.mock('@/src/lib/anthropic/scope-manifest', () => ({
  findAnthropicManifestAsset: vi.fn(),
  readActiveAnthropicScopes: vi.fn(),
  publishAnthropicScopeManifest: vi.fn(),
  anthropicKeySealed: keySealedMock,
  anthropicKeyPending: keyPendingMock,
  VALID_ANTHROPIC_SCOPES: ['anthropic:infer'],
}));

// Importing evaluates the module → the factory is invoked.
const route = await import('../route');

const OWNER = 'did:imajin:veteze';

function getExtraFields(): Promise<Record<string, unknown>> {
  const fn = capturedOpts.current?.getExtraFields as (ownerDid: string) => Promise<Record<string, unknown>>;
  return fn(OWNER);
}

beforeEach(() => {
  keySealedMock.mockReset();
  keyPendingMock.mockReset();
});

describe('/anthropic/api/scope-manifest wiring', () => {
  it('validates fail-closed against the derived Anthropic scope set', () => {
    expect(capturedOpts.current?.name).toBe('Anthropic');
    expect(capturedOpts.current?.validScopes).toEqual(['anthropic:infer']);
  });

  it('exports the handlers the connector card calls', () => {
    for (const method of ['GET', 'POST', 'OPTIONS'] as const) {
      expect(route[method]).toBeDefined();
    }
  });

  it('reports a ready key as sealed and not pending', async () => {
    keySealedMock.mockResolvedValue(true);
    keyPendingMock.mockResolvedValue(false);

    await expect(getExtraFields()).resolves.toEqual({ keySealed: true, credentialPending: false });
    expect(keySealedMock).toHaveBeenCalledWith(OWNER);
  });

  it('distinguishes "awaiting owner approval" from "not connected" (#1603)', async () => {
    // Under Tier 1 a sealed key is unreadable until the owner grants, so
    // keySealed reads false while pending. Reporting only keySealed would render
    // that as "not connected" and invite re-pasting a key already stored.
    keySealedMock.mockResolvedValue(false);
    keyPendingMock.mockResolvedValue(true);

    await expect(getExtraFields()).resolves.toEqual({ keySealed: false, credentialPending: true });
  });
});
