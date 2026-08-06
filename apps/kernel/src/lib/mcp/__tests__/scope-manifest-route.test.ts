import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── MCP scope-manifest route wiring test ─────────────────────────────────────
//
// Verifies the route file passes the correct MCP-specific options to the shared
// factory. GET/POST/OPTIONS behaviour is tested exhaustively in the factory test
// (src/lib/kernel/__tests__/scope-manifest-route.test.ts).

// Capture the opts passed to createConnectorScopeManifestRoute at module load.
const { capturedOpts, mockHandlers } = vi.hoisted(() => ({
  capturedOpts: { current: null as Record<string, unknown> | null },
  mockHandlers: { GET: vi.fn(), POST: vi.fn(), OPTIONS: vi.fn() },
}));

vi.mock('@/src/lib/kernel/scope-manifest-route', () => ({
  createConnectorScopeManifestRoute: vi.fn((opts: Record<string, unknown>) => {
    capturedOpts.current = opts;
    return mockHandlers;
  }),
}));

vi.mock('@/src/lib/mcp/scope-manifest', () => ({
  findMcpManifestAsset: vi.fn(),
  readActiveMcpScopes: vi.fn(),
  publishMcpScopeManifest: vi.fn(async () => 'asset_published'),
  widenMcpClientScopes: vi.fn(async () => undefined),
  VALID_MCP_SCOPES: ['media:read', 'media:write', 'media:share', 'connections:read'],
}));

// Import triggers module evaluation → createConnectorScopeManifestRoute is called.
await import('../../../../app/mcp/api/scope-manifest/route');

import {
  findMcpManifestAsset,
  readActiveMcpScopes,
  publishMcpScopeManifest,
  widenMcpClientScopes,
  VALID_MCP_SCOPES,
} from '@/src/lib/mcp/scope-manifest';

type Publish = (ownerDid: string, scopes: readonly string[]) => Promise<string>;

/** The wrapped `publish` the route handed to the factory. */
function publish(): Publish {
  return capturedOpts.current?.publish as Publish;
}

beforeEach(() => {
  vi.mocked(publishMcpScopeManifest).mockClear();
  vi.mocked(widenMcpClientScopes).mockClear();
  vi.mocked(widenMcpClientScopes).mockResolvedValue(undefined);
});

describe('MCP scope-manifest route wiring', () => {
  it('calls createConnectorScopeManifestRoute with name: MCP', () => {
    expect(capturedOpts.current?.name).toBe('MCP');
  });

  it('passes VALID_MCP_SCOPES as validScopes', () => {
    expect(capturedOpts.current?.validScopes).toBe(VALID_MCP_SCOPES);
  });

  it('passes the MCP reader functions', () => {
    expect(capturedOpts.current?.findManifestAsset).toBe(findMcpManifestAsset);
    expect(capturedOpts.current?.readActiveScopes).toBe(readActiveMcpScopes);
  });

  it('does NOT pass getExtraFields (native connector has no credentials)', () => {
    expect(capturedOpts.current?.getExtraFields).toBeUndefined();
  });
});

// ── publish wrapper (#1647) ───────────────────────────────────────────────────
//
// `publish` is no longer the bare publisher: it also widens the owner's DCR
// client registrations so the next token refresh picks up the newly toggled
// scopes. Without it `registry.apps.requested_scopes` stays frozen at
// registration time and Gate 1 (the JWT `scope` claim) never sees the scope.

describe('MCP scope-manifest route — publish wrapper', () => {
  it('delegates to publishMcpScopeManifest and returns its asset id', async () => {
    const assetId = await publish()('did:owner', ['media:read']);
    expect(publishMcpScopeManifest).toHaveBeenCalledWith('did:owner', ['media:read']);
    expect(assetId).toBe('asset_published');
  });

  it('widens the client registrations with the same owner + scopes', async () => {
    await publish()('did:owner', ['media:read', 'media:write']);
    expect(widenMcpClientScopes).toHaveBeenCalledWith('did:owner', ['media:read', 'media:write']);
  });

  it('does not widen when the core publish throws', async () => {
    vi.mocked(publishMcpScopeManifest).mockRejectedValueOnce(new Error('publish failed'));
    await expect(publish()('did:owner', ['media:read'])).rejects.toThrow('publish failed');
    expect(widenMcpClientScopes).not.toHaveBeenCalled();
  });

  it('still resolves when widening rejects (fire-and-forget)', async () => {
    vi.mocked(widenMcpClientScopes).mockRejectedValueOnce(new Error('widen failed'));
    await expect(publish()('did:owner', ['media:read'])).resolves.toBe('asset_published');
  });
});
