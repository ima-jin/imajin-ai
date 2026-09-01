/**
 * OpenAI route wiring tests (#1927).
 *
 * The token, disconnect and scope-manifest routes are pure wiring over shared
 * factories, so the only thing that can be wrong is which connector they are
 * bound to — and that failure is silent: a crossed wire seals an OpenAI key
 * into another provider's vault field, or disconnects the wrong credential.
 * Factory behaviour itself is covered in `src/lib/kernel/__tests__/`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  tokenOpts, disconnectOpts, manifestOpts, handlers,
  sealApiKey, keySealed, keyPending, revokeApiKey,
  findAsset, readScopes, publish,
} = vi.hoisted(() => ({
  tokenOpts: { current: null as Record<string, unknown> | null },
  disconnectOpts: { current: null as Record<string, unknown> | null },
  manifestOpts: { current: null as Record<string, unknown> | null },
  handlers: { GET: vi.fn(), POST: vi.fn(), OPTIONS: vi.fn() },
  sealApiKey: vi.fn(),
  keySealed: vi.fn(),
  keyPending: vi.fn(),
  revokeApiKey: vi.fn(),
  findAsset: vi.fn(),
  readScopes: vi.fn(),
  publish: vi.fn(),
}));

vi.mock('@/src/lib/kernel/connector-token-route', () => ({
  createConnectorTokenRoutes: vi.fn((opts: Record<string, unknown>) => {
    tokenOpts.current = opts;
    return handlers;
  }),
  createConnectorTokenDisconnectRoute: vi.fn((opts: Record<string, unknown>) => {
    disconnectOpts.current = opts;
    return handlers;
  }),
}));

vi.mock('@/src/lib/kernel/scope-manifest-route', () => ({
  createConnectorScopeManifestRoute: vi.fn((opts: Record<string, unknown>) => {
    manifestOpts.current = opts;
    return handlers;
  }),
}));

vi.mock('@/src/lib/openai/connector', () => ({
  sealApiKey,
  openaiKeySealed: keySealed,
  revokeApiKey,
}));

vi.mock('@/src/lib/openai/scope-manifest', () => ({
  findOpenaiManifestAsset: findAsset,
  readActiveOpenaiScopes: readScopes,
  publishOpenaiScopeManifest: publish,
  openaiKeySealed: keySealed,
  openaiKeyPending: keyPending,
  VALID_OPENAI_SCOPES: ['openai:infer'],
}));

// Importing evaluates each route module → each factory records its options.
const tokenRoute = await import('../../../../app/openai/api/token/route');
const disconnectRoute = await import('../../../../app/openai/api/disconnect/route');
const manifestRoute = await import('../../../../app/openai/api/scope-manifest/route');

const OWNER = 'did:imajin:farmer';

beforeEach(() => {
  keySealed.mockReset();
  keyPending.mockReset();
});

describe('token route', () => {
  it('seals through the OpenAI connector, and nothing else', () => {
    expect(tokenOpts.current).toMatchObject({ name: 'OpenAI' });
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
  it('revokes the OpenAI grant', () => {
    expect(disconnectOpts.current).toMatchObject({ name: 'OpenAI' });
    expect(disconnectOpts.current?.revokeApiKey).toBe(revokeApiKey);
  });

  /**
   * No GET: disconnect is a state change, and a readable disconnect endpoint
   * is one CSRF-shaped mistake away from being triggered by a link.
   */
  it('exposes POST and OPTIONS only', () => {
    expect(disconnectRoute.POST).toBeDefined();
    expect(disconnectRoute.OPTIONS).toBeDefined();
    expect((disconnectRoute as Record<string, unknown>).GET).toBeUndefined();
  });
});

describe('scope-manifest route', () => {
  it('validates fail-closed against the derived OpenAI scope list', () => {
    expect(manifestOpts.current).toMatchObject({ name: 'OpenAI', validScopes: ['openai:infer'] });
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
