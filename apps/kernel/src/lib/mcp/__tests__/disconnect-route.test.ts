import { describe, it, expect, vi } from 'vitest';

// ─── MCP disconnect route wiring test (#1592) ─────────────────────────────────
//
// Verifies the route hands the shared native-disconnect factory the MCP identity
// and — the part that matters — the SAME publisher the scope toggles use. A
// revoke that went through a bespoke publisher would be free to drift from the
// grant path, which is exactly the split this connector's grant-by-edit model
// exists to avoid. Handler behaviour is covered in
// src/lib/kernel/__tests__/connector-native-disconnect.test.ts.

const { capturedOpts, mockHandlers } = vi.hoisted(() => ({
  capturedOpts: { current: null as Record<string, unknown> | null },
  mockHandlers: { POST: vi.fn(), OPTIONS: vi.fn() },
}));

vi.mock('@/src/lib/kernel/connector-native-disconnect', () => ({
  createNativeDisconnectHandler: vi.fn((opts: Record<string, unknown>) => {
    capturedOpts.current = opts;
    return mockHandlers;
  }),
}));

vi.mock('@/src/lib/mcp/scope-manifest', () => ({
  publishMcpScopeManifest: vi.fn(async () => 'asset_published'),
  readActiveMcpScopes: vi.fn(async () => []),
}));

// Import triggers module evaluation → createNativeDisconnectHandler is called.
await import('../../../../app/mcp/api/disconnect/route');

import { publishMcpScopeManifest, readActiveMcpScopes } from '@/src/lib/mcp/scope-manifest';
import { MCP_CONNECTOR_DID, MCP_CHANNEL } from '../oauth-config';

describe('MCP disconnect route wiring', () => {
  it('targets the mcp channel and connector DID', () => {
    expect(capturedOpts.current?.channel).toBe(MCP_CHANNEL);
    expect(capturedOpts.current?.connectorDid).toBe(MCP_CONNECTOR_DID);
    expect(capturedOpts.current?.connectorName).toBe('mcp');
  });

  it('revokes through the same publisher the scope toggles grant through', () => {
    expect(capturedOpts.current?.publishScopeManifest).toBe(publishMcpScopeManifest);
  });

  it('reads back active scopes with the connector reader, so the verify is real', () => {
    expect(capturedOpts.current?.readActiveScopes).toBe(readActiveMcpScopes);
  });
});
