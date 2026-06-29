import { describe, it, expect, vi } from 'vitest';

// Mock the tool registry so the gate can be exercised without pulling in the
// db-backed media tools (vitest does not resolve the @/* path alias). This still
// tests the REAL gate logic in server.ts.
vi.mock('../tools', () => {
  const tools = [
    { name: 't_read', requiredScope: 'media:read', description: 'r', inputSchema: {}, handler: () => [{ type: 'text', text: 'read-ok' }] },
    { name: 't_write', requiredScope: 'media:write', description: 'w', inputSchema: {}, handler: () => [{ type: 'text', text: 'write-ok' }] },
    { name: 't_ping', description: 'p', inputSchema: {}, handler: () => [{ type: 'text', text: 'pong' }] },
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
