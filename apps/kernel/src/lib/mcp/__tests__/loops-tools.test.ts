/**
 * Tests for the loops MCP tools (#2297).
 *
 * `loops_list` / `loops_get` are thin readers over `../../loops/query`
 * (mocked here; its own SQL is covered by `lib/loops/__tests__/query.test.ts`).
 * What matters at this layer is:
 *   - `loops:read` gates both tools, checked via the real scope gate in
 *     server.ts AND the scope-manifest grant via `requireMcpGrant`;
 *   - every query is pinned to `ctx.did` as `principal`, never a tool
 *     argument, so one principal can never read another's loops;
 *   - loops_list forwards filters (including cursor) and returns the page
 *     shape verbatim;
 *   - loops_get fails closed (not_found) on a miss, indistinguishable from a
 *     cross-principal hit the query lib already hid.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { McpContent, McpToolContext } from '../types';

// ─── Mocks ─────────────────────────────────────────────────────────────────

const mockRequireMcpGrant = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
// `resolveActiveMcpGrant` backs server.ts's stale-token cross-check on a scope
// denial (Gate 1 fails → it asks Gate 2 whether to report scope_token_stale
// instead of insufficient_scope) — mocked to "no grant" so the plain-denial
// path the scope-gate tests assert on is what actually runs.
const mockResolveActiveMcpGrant = vi.hoisted(() => vi.fn().mockResolvedValue(false));
vi.mock('../mcp-grant', () => ({
  requireMcpGrant: mockRequireMcpGrant,
  resolveActiveMcpGrant: mockResolveActiveMcpGrant,
}));

const mockListLoopsPage = vi.hoisted(() => vi.fn());
const mockGetLoopWithHistory = vi.hoisted(() => vi.fn());
vi.mock('../../loops/query', () => ({
  listLoopsPage: mockListLoopsPage,
  getLoopWithHistory: mockGetLoopWithHistory,
}));

// Swap the registry for the real loops tools only, so the scope gate in
// server.ts runs against them without loading every other (DB-backed) tool
// module (same technique as corpus-tools.test.ts / inference-tools.test.ts).
vi.mock('../tools', async () => {
  const { loopsTools } = await import('../tools/loops');
  const byName = new Map(loopsTools.map((t) => [t.name, t]));
  return { ALL_TOOLS: loopsTools, toolByName: (n: string) => byName.get(n) };
});

import { handleMcpRpc } from '../server';
import { loopsTools } from '../tools/loops';

// ─── Helpers ───────────────────────────────────────────────────────────────

function tool(name: string) {
  const t = loopsTools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
}

function ctxFor(did: string): McpToolContext {
  return { did, appDid: 'did:imajin:mcp-connector', scopes: new Set(['loops:read']) };
}

async function call(name: string, args: Record<string, unknown>, ctx: McpToolContext): Promise<McpContent[]> {
  return (await tool(name).handler(args, ctx)) as McpContent[];
}

function parseResult(content: McpContent[]) {
  return JSON.parse(content[0].text);
}

/** Gate-level call, through the real handleMcpRpc dispatch + scope check. */
function callViaGate(name: string, scopes: string[], args: Record<string, unknown> = {}) {
  const ctx = ctxFor('did:imajin:alice');
  ctx.scopes = new Set(scopes);
  return handleMcpRpc(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    ctx,
  ) as Promise<any>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireMcpGrant.mockResolvedValue(undefined);
  mockResolveActiveMcpGrant.mockResolvedValue(false);
  mockListLoopsPage.mockResolvedValue({ loops: [], hasNextPage: false, nextCursor: null });
  mockGetLoopWithHistory.mockResolvedValue(null);
});

// ─── Registration ────────────────────────────────────────────────────────────

describe('loops tool registration', () => {
  it('exports loops_list and loops_get', () => {
    expect(loopsTools.map((t) => t.name)).toEqual(['loops_list', 'loops_get']);
  });

  it('gates both tools on loops:read', () => {
    expect(tool('loops_list').requiredScope).toBe('loops:read');
    expect(tool('loops_get').requiredScope).toBe('loops:read');
  });

  it('rejects unknown arguments on both tool schemas (fail-closed)', () => {
    for (const t of loopsTools) {
      expect(t.inputSchema.additionalProperties).toBe(false);
    }
  });
});

// ─── loops_list — happy path ─────────────────────────────────────────────────

describe('loops_list', () => {
  it('resolves the acting DID as principal and forwards filters', async () => {
    mockListLoopsPage.mockResolvedValueOnce({
      loops: [{ loopId: 'loop_1', kind: 'warp.run', state: 'running' }],
      hasNextPage: false,
      nextCursor: null,
    });

    const out = parseResult(
      await call(
        'loops_list',
        { state: 'running', kind: 'warp.run', since: '2026-09-01T00:00:00Z', limit: 10 },
        ctxFor('did:imajin:alice'),
      ),
    );

    expect(mockListLoopsPage).toHaveBeenCalledWith({
      principal: 'did:imajin:alice',
      state: 'running',
      kind: 'warp.run',
      since: '2026-09-01T00:00:00Z',
      limit: 10,
    });
    expect(out).toEqual({ loops: [{ loopId: 'loop_1', kind: 'warp.run', state: 'running' }], hasNextPage: false, nextCursor: null });
  });

  it('forwards ancestor filters for a lineage read', async () => {
    await call('loops_list', { ancestor: 'loop_root' }, ctxFor('did:imajin:alice'));

    expect(mockListLoopsPage).toHaveBeenCalledWith({ principal: 'did:imajin:alice', ancestor: 'loop_root' });
  });

  it('checks the scope-manifest grant before querying', async () => {
    await call('loops_list', {}, ctxFor('did:imajin:alice'));

    expect(mockRequireMcpGrant).toHaveBeenCalledWith('did:imajin:alice', 'loops:read', 'did:imajin:mcp-connector');
  });

  it('never lets a tool argument override the acting principal', async () => {
    // "principal"/"did" are not even in the input schema; a client that sends
    // one anyway must still be scoped to ctx.did, never the injected value.
    await call(
      'loops_list',
      { state: 'running', principal: 'did:imajin:mallory', did: 'did:imajin:mallory' } as Record<string, unknown>,
      ctxFor('did:imajin:bob'),
    );

    expect(mockListLoopsPage).toHaveBeenCalledWith(expect.objectContaining({ principal: 'did:imajin:bob' }));
  });

  // ─── pagination cursor ─────────────────────────────────────────────────────

  it('forwards an explicit cursor and returns the page\u2019s hasNextPage/nextCursor verbatim', async () => {
    mockListLoopsPage.mockResolvedValueOnce({
      loops: [{ loopId: 'loop_2' }],
      hasNextPage: true,
      nextCursor: 'opaque-cursor-token',
    });

    const out = parseResult(
      await call('loops_list', { cursor: 'prior-page-cursor', limit: 1 }, ctxFor('did:imajin:alice')),
    );

    expect(mockListLoopsPage).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: 'prior-page-cursor', limit: 1 }),
    );
    expect(out).toEqual({ loops: [{ loopId: 'loop_2' }], hasNextPage: true, nextCursor: 'opaque-cursor-token' });
  });

  it('omits cursor from the query filters when not provided', async () => {
    await call('loops_list', {}, ctxFor('did:imajin:alice'));

    const filtersArg = mockListLoopsPage.mock.calls[0][0];
    expect(filtersArg).not.toHaveProperty('cursor');
  });
});

// ─── loops_get — happy path + not-found ──────────────────────────────────────

describe('loops_get', () => {
  it('reads by loop_id, scoped to the acting DID', async () => {
    mockGetLoopWithHistory.mockResolvedValueOnce({
      loop: { loopId: 'loop_1', state: 'blocked' },
      events: [{ type: 'loop.started' }, { type: 'loop.blocked' }],
    });

    const out = parseResult(await call('loops_get', { loop_id: 'loop_1' }, ctxFor('did:imajin:alice')));

    expect(mockGetLoopWithHistory).toHaveBeenCalledWith('loop_1', 'did:imajin:alice');
    expect(out.loop.loopId).toBe('loop_1');
    expect(out.events.map((e: { type: string }) => e.type)).toEqual(['loop.started', 'loop.blocked']);
  });

  it('requires loop_id', async () => {
    await expect(call('loops_get', {}, ctxFor('did:imajin:alice'))).rejects.toThrow('loop_id is required');
    expect(mockGetLoopWithHistory).not.toHaveBeenCalled();
  });

  it('fails closed with not_found for an unknown loop id', async () => {
    mockGetLoopWithHistory.mockResolvedValueOnce(null);

    await expect(call('loops_get', { loop_id: 'loop_missing' }, ctxFor('did:imajin:alice'))).rejects.toThrow(
      /not_found/,
    );
  });

  it('fails closed with the SAME not_found error for a loop owned by a different principal', async () => {
    // The query lib itself never reveals cross-principal existence (see
    // query.test.ts): a hit for a different principal comes back as `null`,
    // identical to an unknown id, and the tool must not distinguish them.
    mockGetLoopWithHistory.mockResolvedValueOnce(null);

    await expect(call('loops_get', { loop_id: 'loop_owned_by_bob' }, ctxFor('did:imajin:alice'))).rejects.toThrow(
      /not_found/,
    );
    expect(mockGetLoopWithHistory).toHaveBeenCalledWith('loop_owned_by_bob', 'did:imajin:alice');
  });

  it('checks the scope-manifest grant before querying', async () => {
    mockGetLoopWithHistory.mockResolvedValueOnce({ loop: { loopId: 'loop_1' }, events: [] });

    await call('loops_get', { loop_id: 'loop_1' }, ctxFor('did:imajin:alice'));

    expect(mockRequireMcpGrant).toHaveBeenCalledWith('did:imajin:alice', 'loops:read', 'did:imajin:mcp-connector');
  });
});

// ─── The scope gate ──────────────────────────────────────────────────────────

describe('scope gate', () => {
  it('denies loops_list to a token without loops:read', async () => {
    const res = await callViaGate('loops_list', ['media:read']);
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('insufficient_scope');
    expect(res.result.content[0].text).toContain('loops:read');
    expect(mockListLoopsPage).not.toHaveBeenCalled();
  });

  it('denies loops_get to a token without loops:read', async () => {
    const res = await callViaGate('loops_get', [], { loop_id: 'loop_1' });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('insufficient_scope');
    expect(mockGetLoopWithHistory).not.toHaveBeenCalled();
  });

  it('lets a loops:read token reach both handlers', async () => {
    const listRes = await callViaGate('loops_list', ['loops:read']);
    expect(listRes.result.isError).toBe(false);

    const getRes = await callViaGate('loops_get', ['loops:read'], { loop_id: 'loop_1' });
    // Resolves to the mocked not_found (null) path — proof the gate passed the
    // call through, not that the loop happens to exist.
    expect(getRes.result.isError).toBe(true);
    expect(getRes.result.content[0].text).toContain('not_found');
  });
});
