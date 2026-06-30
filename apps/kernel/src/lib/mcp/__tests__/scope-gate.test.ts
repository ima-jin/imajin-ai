import { describe, it, expect, vi } from 'vitest';

// Mock the tool registry so the gate can be exercised without pulling in the
// db-backed media tools (vitest does not resolve the @/* path alias). This still
// tests the REAL gate logic in server.ts.
vi.mock('../tools', () => {
  const tools = [
    { name: 't_read',        requiredScope: 'media:read',       description: 'r', inputSchema: {}, handler: () => [{ type: 'text', text: 'read-ok' }] },
    { name: 't_write',       requiredScope: 'media:write',      description: 'w', inputSchema: {}, handler: () => [{ type: 'text', text: 'write-ok' }] },
    { name: 't_share',       requiredScope: 'media:share',      description: 's', inputSchema: {}, handler: () => [{ type: 'text', text: 'share-ok' }] },
    { name: 't_connections', requiredScope: 'connections:read', description: 'c', inputSchema: {}, handler: () => [{ type: 'text', text: 'connections-ok' }] },
    { name: 't_ping',        description: 'p', inputSchema: {}, handler: () => [{ type: 'text', text: 'pong' }] },
  ];
  const byName = new Map(tools.map((t) => [t.name, t]));
  return { ALL_TOOLS: tools, toolByName: (n: string) => byName.get(n) };
});

import { handleMcpRpc } from '../server';

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
