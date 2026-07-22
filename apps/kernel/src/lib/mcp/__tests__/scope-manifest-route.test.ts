import { describe, it, expect, vi } from 'vitest';

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
  publishMcpScopeManifest: vi.fn(),
  VALID_MCP_SCOPES: ['media:read', 'media:write', 'media:share', 'connections:read'],
}));

// Import triggers module evaluation → createConnectorScopeManifestRoute is called.
await import('../../../../app/mcp/api/scope-manifest/route');

import {
  findMcpManifestAsset,
  readActiveMcpScopes,
  publishMcpScopeManifest,
  VALID_MCP_SCOPES,
} from '@/src/lib/mcp/scope-manifest';

describe('MCP scope-manifest route wiring', () => {
  it('calls createConnectorScopeManifestRoute with name: MCP', () => {
    expect(capturedOpts.current?.name).toBe('MCP');
  });

  it('passes VALID_MCP_SCOPES as validScopes', () => {
    expect(capturedOpts.current?.validScopes).toBe(VALID_MCP_SCOPES);
  });

  it('passes the MCP publisher functions', () => {
    expect(capturedOpts.current?.findManifestAsset).toBe(findMcpManifestAsset);
    expect(capturedOpts.current?.readActiveScopes).toBe(readActiveMcpScopes);
    expect(capturedOpts.current?.publish).toBe(publishMcpScopeManifest);
  });

  it('does NOT pass getExtraFields (native connector has no credentials)', () => {
    expect(capturedOpts.current?.getExtraFields).toBeUndefined();
  });
});
