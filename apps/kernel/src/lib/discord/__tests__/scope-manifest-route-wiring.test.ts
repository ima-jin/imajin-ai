import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Discord scope-manifest ROUTE wiring test (#1521) ─────────────────────────
//
// Verifies the app route's getExtraFields runs both discordTokenSealed and
// discordCredentialPending and merges them into a single object, so the card
// can distinguish "not connected" from "waiting for owner approval".

const { capturedOpts, mockHandlers, tokenSealedMock, credentialPendingMock } = vi.hoisted(() => ({
  capturedOpts: { current: null as Record<string, unknown> | null },
  mockHandlers: { GET: vi.fn(), POST: vi.fn(), OPTIONS: vi.fn() },
  tokenSealedMock: vi.fn(),
  credentialPendingMock: vi.fn(),
}));

vi.mock('@/src/lib/kernel/scope-manifest-route', () => ({
  createConnectorScopeManifestRoute: vi.fn((opts: Record<string, unknown>) => {
    capturedOpts.current = opts;
    return mockHandlers;
  }),
}));

vi.mock('@/src/lib/discord/scope-manifest', () => ({
  findDiscordManifestAsset: vi.fn(),
  readActiveDiscordScopes: vi.fn(),
  publishDiscordScopeManifest: vi.fn(),
  discordTokenSealed: tokenSealedMock,
  discordCredentialPending: credentialPendingMock,
  VALID_DISCORD_SCOPES: ['discord:post', 'discord:read'],
}));

// Import triggers module evaluation → createConnectorScopeManifestRoute is called.
await import('../../../../app/discord/api/scope-manifest/route');

const OWNER = 'did:imajin:owner';

describe('Discord scope-manifest route wiring (#1521)', () => {
  beforeEach(() => {
    tokenSealedMock.mockReset();
    credentialPendingMock.mockReset();
  });

  async function getExtraFields(): Promise<Record<string, unknown>> {
    const fn = capturedOpts.current?.getExtraFields as (ownerDid: string) => Promise<Record<string, unknown>>;
    return fn(OWNER);
  }

  it('reports tokenSealed true and credentialPending false when the token is ready', async () => {
    tokenSealedMock.mockResolvedValue(true);
    credentialPendingMock.mockResolvedValue(false);
    expect(await getExtraFields()).toEqual({ tokenSealed: true, credentialPending: false });
    expect(tokenSealedMock).toHaveBeenCalledWith(OWNER);
    expect(credentialPendingMock).toHaveBeenCalledWith(OWNER);
  });

  it('reports credentialPending true when sealed but awaiting an owner grant', async () => {
    tokenSealedMock.mockResolvedValue(false);
    credentialPendingMock.mockResolvedValue(true);
    expect(await getExtraFields()).toEqual({ tokenSealed: false, credentialPending: true });
  });
});
