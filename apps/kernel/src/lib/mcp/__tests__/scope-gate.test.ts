import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the tool registry so the gate can be exercised without pulling in the
// db-backed media tools (vitest does not resolve the @/* path alias). This still
// tests the REAL gate logic in server.ts.
vi.mock('../tools', () => {
  const tools = [
    { name: 't_read',        requiredScope: 'media:read',       description: 'r', inputSchema: {}, handler: () => [{ type: 'text', text: 'read-ok' }] },
    { name: 't_write',       requiredScope: 'media:write',      description: 'w', inputSchema: {}, handler: () => [{ type: 'text', text: 'write-ok' }] },
    { name: 't_share',       requiredScope: 'media:share',      description: 's', inputSchema: {}, handler: () => [{ type: 'text', text: 'share-ok' }] },
    { name: 't_connections', requiredScope: 'connections:read', description: 'c', inputSchema: {}, handler: () => [{ type: 'text', text: 'connections-ok' }] },
    { name: 't_msg_read',    requiredScope: 'messages:read',    description: 'mr', inputSchema: {}, handler: () => [{ type: 'text', text: 'messages-read-ok' }] },
    { name: 't_msg_write',   requiredScope: 'messages:write',   description: 'mw', inputSchema: {}, handler: () => [{ type: 'text', text: 'messages-write-ok' }] },
    { name: 't_dispatch',    requiredScope: 'warp:dispatch',    description: 'd', inputSchema: {}, handler: () => [{ type: 'text', text: 'dispatch-ok' }] },
    { name: 't_discovery',   requiredScope: 'discovery:read',   description: 'dr', inputSchema: {}, handler: () => [{ type: 'text', text: 'discovery-ok' }] },
    { name: 't_infer_read',  requiredScope: 'inference:read',   description: 'ir', inputSchema: {}, handler: () => [{ type: 'text', text: 'inference-read-ok' }] },
    { name: 't_infer_write', requiredScope: 'inference:write',  description: 'iw', inputSchema: {}, handler: () => [{ type: 'text', text: 'inference-write-ok' }] },
    { name: 't_ping',        description: 'p', inputSchema: {}, handler: () => [{ type: 'text', text: 'pong' }] },
  ];
  const byName = new Map(tools.map((t) => [t.name, t]));
  return { ALL_TOOLS: tools, toolByName: (n: string) => byName.get(n) };
});

// Mock the Gate 2 (channel_links) lookup so the stale-token cross-check can be
// exercised without a database. Defaults to "no grant" in beforeEach, which is
// the pre-#1647 behaviour every other test in this file asserts.
const mockResolveGrant = vi.hoisted(() => vi.fn<(did: string, scope: string) => Promise<boolean>>());
vi.mock('../mcp-grant', () => ({
  resolveActiveMcpGrant: (...args: [string, string]) => mockResolveGrant(...args),
}));

import { handleMcpRpc } from '../server';

beforeEach(() => {
  mockResolveGrant.mockReset();
  mockResolveGrant.mockResolvedValue(false);
});

function call(name: string, scopes: string[]) {
  const ctx = { did: 'did:imajin:user', appDid: 'did:imajin:app', scopes: new Set(scopes) };
  return handleMcpRpc(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } },
    ctx,
  ) as Promise<any>;
}

describe('per-tool scope gate (read-grant != write-grant)', () => {
  it('denies a read-only token calling a write tool, in-band', async () => {
    const res = await call('t_write', ['media:read']);
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('insufficient_scope');
    expect(res.result.content[0].text).toContain('media:write');
  });

  it('allows a read-only token calling a read tool', async () => {
    const res = await call('t_read', ['media:read']);
    expect(res.result.isError).toBe(false);
    expect(res.result.content[0].text).toBe('read-ok');
  });

  it('denies a write-only token calling a read tool, in-band', async () => {
    const res = await call('t_read', ['media:write']);
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('insufficient_scope');
    expect(res.result.content[0].text).toContain('media:read');
  });

  it('allows a write-only token calling a write tool', async () => {
    const res = await call('t_write', ['media:write']);
    expect(res.result.isError).toBe(false);
    expect(res.result.content[0].text).toBe('write-ok');
  });

  it('allows a token holding both scopes to call either tool', async () => {
    const read = await call('t_read', ['media:read', 'media:write']);
    const write = await call('t_write', ['media:read', 'media:write']);
    expect(read.result.isError).toBe(false);
    expect(write.result.isError).toBe(false);
  });

  it('allows a tool with no requiredScope (e.g. ping) for any media grant', async () => {
    const res = await call('t_ping', ['media:read']);
    expect(res.result.isError).toBe(false);
    expect(res.result.content[0].text).toBe('pong');
  });

  it('returns a JSON-RPC error for an unknown tool', async () => {
    const res = await call('does_not_exist', ['media:read', 'media:write']);
    expect(res.error.code).toBe(-32602);
  });
});

describe('media:share scope gate', () => {
  it('denies a read/write-only token calling media_grant_access', async () => {
    const readOnly = await call('t_share', ['media:read']);
    expect(readOnly.result.isError).toBe(true);
    expect(readOnly.result.content[0].text).toContain('insufficient_scope');
    expect(readOnly.result.content[0].text).toContain('media:share');

    const writeOnly = await call('t_share', ['media:write']);
    expect(writeOnly.result.isError).toBe(true);
    expect(writeOnly.result.content[0].text).toContain('media:share');
  });

  it('allows a media:share token calling the share tool', async () => {
    const res = await call('t_share', ['media:share']);
    expect(res.result.isError).toBe(false);
    expect(res.result.content[0].text).toBe('share-ok');
  });

  it('allows a full-default token (read+write+share+connections) to call the share tool', async () => {
    const res = await call('t_share', ['media:read', 'media:write', 'media:share', 'connections:read']);
    expect(res.result.isError).toBe(false);
  });
});

describe('messages scope gate (read != write)', () => {
  it('denies a read-only token calling the send tool, in-band', async () => {
    const res = await call('t_msg_write', ['messages:read']);
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('insufficient_scope');
    expect(res.result.content[0].text).toContain('messages:write');
  });

  it('allows a messages:read token calling a read tool', async () => {
    const res = await call('t_msg_read', ['messages:read']);
    expect(res.result.isError).toBe(false);
    expect(res.result.content[0].text).toBe('messages-read-ok');
  });

  it('denies a write-only token calling a read tool, in-band', async () => {
    const res = await call('t_msg_read', ['messages:write']);
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('messages:read');
  });

  it('allows a messages:write token calling the send tool', async () => {
    const res = await call('t_msg_write', ['messages:write']);
    expect(res.result.isError).toBe(false);
    expect(res.result.content[0].text).toBe('messages-write-ok');
  });
});

/**
 * #1636 — the read-only discovery surface is a scope of its own.
 *
 * The point of splitting it out of `warp:dispatch` is that reading what the
 * system exposes must not imply the ability to spend money on a cloud agent, and
 * vice versa. These assert the gate keeps that split in both directions.
 */
describe('discovery:read scope gate (read != dispatch)', () => {
  it('allows a discovery:read-only token calling a discovery tool', async () => {
    const res = await call('t_discovery', ['discovery:read']);
    expect(res.result.isError).toBe(false);
    expect(res.result.content[0].text).toBe('discovery-ok');
  });

  it('denies a discovery:read-only token calling the dispatch tool, in-band', async () => {
    const res = await call('t_dispatch', ['discovery:read']);
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('insufficient_scope');
    expect(res.result.content[0].text).toContain('warp:dispatch');
  });

  it('denies a dispatch-only token calling a discovery tool, in-band', async () => {
    const res = await call('t_discovery', ['warp:dispatch']);
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('insufficient_scope');
    expect(res.result.content[0].text).toContain('discovery:read');
  });

  it('denies a media-only token calling a discovery tool, in-band', async () => {
    const res = await call('t_discovery', ['media:read', 'media:write']);
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('discovery:read');
  });

  it('allows a token holding both Warp scopes to call either tool', async () => {
    const discovery = await call('t_discovery', ['warp:dispatch', 'discovery:read']);
    const dispatch = await call('t_dispatch', ['warp:dispatch', 'discovery:read']);
    expect(discovery.result.isError).toBe(false);
    expect(dispatch.result.isError).toBe(false);
  });
});

/**
 * #1647 — a scope toggled on in the dashboard writes a `channel_links` row
 * immediately (Gate 2), but the access token stays frozen at issuance (Gate 1).
 * Without the cross-check the user sees a bare `insufficient_scope` and has no
 * way to tell "enable the scope" from "refresh your token".
 */
describe('stale-token detection (#1647)', () => {
  it('returns scope_token_stale when token lacks scope but channel_links grant is active', async () => {
    mockResolveGrant.mockResolvedValue(true);
    const res = await call('t_write', ['media:read']);
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('scope_token_stale');
    expect(res.result.content[0].text).toContain('refresh your token');
    expect(mockResolveGrant).toHaveBeenCalledWith('did:imajin:user', 'media:write');
  });

  it('returns insufficient_scope when token lacks scope and no channel_links grant exists', async () => {
    mockResolveGrant.mockResolvedValue(false);
    const res = await call('t_write', ['media:read']);
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('insufficient_scope');
    expect(res.result.content[0].text).not.toContain('scope_token_stale');
  });

  it('does not cross-check when token has the required scope', async () => {
    const res = await call('t_write', ['media:write']);
    expect(res.result.isError).toBe(false);
    expect(mockResolveGrant).not.toHaveBeenCalled();
  });

  it('does not cross-check for tools with no requiredScope', async () => {
    const res = await call('t_ping', ['media:read']);
    expect(res.result.isError).toBe(false);
    expect(mockResolveGrant).not.toHaveBeenCalled();
  });

  it('cross-checks each scope independently (messages:read)', async () => {
    mockResolveGrant.mockResolvedValue(true);
    const res = await call('t_msg_read', ['media:read']);
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('scope_token_stale');
    expect(mockResolveGrant).toHaveBeenCalledWith('did:imajin:user', 'messages:read');
  });
});

/**
 * #1298 — the inference tools used to gate on `media:write` / `media:read`, so
 * any agent that could upload a file could also drive the intention-inference
 * pipeline and have a supply attestation signed on the owner's behalf. These
 * assert the two grants are now genuinely separate in both directions.
 */
describe('inference scope gate (decoupled from media — #1298)', () => {
  it('denies a media:write token calling the capture tool, in-band', async () => {
    const res = await call('t_infer_write', ['media:read', 'media:write', 'media:share']);
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('insufficient_scope');
    expect(res.result.content[0].text).toContain('inference:write');
  });

  it('denies a media:read token calling the status tool, in-band', async () => {
    const res = await call('t_infer_read', ['media:read']);
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('insufficient_scope');
    expect(res.result.content[0].text).toContain('inference:read');
  });

  it('allows an inference:write token calling the capture tool', async () => {
    const res = await call('t_infer_write', ['inference:write']);
    expect(res.result.isError).toBe(false);
    expect(res.result.content[0].text).toBe('inference-write-ok');
  });

  it('allows an inference:read token calling the status tool', async () => {
    const res = await call('t_infer_read', ['inference:read']);
    expect(res.result.isError).toBe(false);
    expect(res.result.content[0].text).toBe('inference-read-ok');
  });

  it('keeps read and write separate from each other', async () => {
    const readWithWrite = await call('t_infer_read', ['inference:write']);
    expect(readWithWrite.result.isError).toBe(true);
    expect(readWithWrite.result.content[0].text).toContain('inference:read');

    const writeWithRead = await call('t_infer_write', ['inference:read']);
    expect(writeWithRead.result.isError).toBe(true);
    expect(writeWithRead.result.content[0].text).toContain('inference:write');
  });

  it('does not let an inference grant reach the media tools', async () => {
    const res = await call('t_write', ['inference:read', 'inference:write']);
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('media:write');
  });
});

describe('connections:read scope gate', () => {
  it('denies a read/write-only token calling connections_list', async () => {
    const readOnly = await call('t_connections', ['media:read']);
    expect(readOnly.result.isError).toBe(true);
    expect(readOnly.result.content[0].text).toContain('insufficient_scope');
    expect(readOnly.result.content[0].text).toContain('connections:read');

    const writeOnly = await call('t_connections', ['media:write']);
    expect(writeOnly.result.isError).toBe(true);
    expect(writeOnly.result.content[0].text).toContain('connections:read');
  });

  it('allows a connections:read token calling the connections tool', async () => {
    const res = await call('t_connections', ['connections:read']);
    expect(res.result.isError).toBe(false);
    expect(res.result.content[0].text).toBe('connections-ok');
  });

  it('denies a connections:read-only token from calling media tools', async () => {
    const res = await call('t_read', ['connections:read']);
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('media:read');
  });
});
