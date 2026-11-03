import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { NextRequest } from 'next/server';
import type { McpToolContext } from '../types';
import type { ConnectionCaller } from '@/src/lib/kernel/connection-principal-policy';

const h = vi.hoisted(() => ({
  ownerDid: '', caller: {} as ConnectionCaller, credential: '', unavailable: false,
  publish: vi.fn(), key: vi.fn(), resolve: vi.fn(),
}));
vi.mock('@/src/lib/mcp/agent-binding', () => ({
  AgentOAuthError: class extends Error {
    constructor(readonly code: string, message: string) { super(message); this.name = 'AgentOAuthError'; }
  },
  mcpCredentialContext: h.resolve,
}));
vi.mock('@/src/lib/warp/connector', () => ({
  requireAgentKey: h.key, sealWarpAgentKey: vi.fn(), WARP_DISPATCH_SCOPE: 'warp:dispatch',
}));
vi.mock('@/src/lib/warp/dispatch', async importOriginal => ({
  ...await importOriginal<typeof import('@/src/lib/warp/dispatch')>(), watchRun: vi.fn(),
}));
vi.mock('@/src/lib/warp/brief-ledger', () => ({
  recordWarpBrief: vi.fn(async () => ({ hash: 'a'.repeat(64), assetId: 'asset_test', storage: 'full-text', browserTesting: null })),
  recordWarpBriefDispatchFailed: vi.fn(),
}));
vi.mock('@/src/lib/warp/loop-emit', () => ({ emitWarpRunLoopEvent: vi.fn(async () => true) }));
vi.mock('@/src/lib/warp/environment', () => ({ readEnvironmentId: vi.fn(async () => undefined) }));
vi.mock('@/src/lib/kernel/lookup', () => ({ lookupIdentity: vi.fn(async (did: string) => ({ did, handle: did.split(':').at(-1) })) }));
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeDid: async () => '' }));
vi.mock('@/src/lib/warp/run-watch-sweep', () => ({ claimTerminalPublish: vi.fn() }));
vi.mock('@/src/lib/kernel/cors', () => ({ corsHeaders: () => ({}), corsOptions: vi.fn() }));
vi.mock('@imajin/bus', () => ({ publish: h.publish }));
vi.mock('@imajin/auth', async importOriginal => ({
  ...await importOriginal<typeof import('@imajin/auth')>(),
  requireAppAuth: vi.fn(async () => ({ appAuth: {
    userDid: h.caller.actorDid, appDid: h.caller.actorDid,
    actingFor: h.caller.actingFor, actingAs: h.caller.actingAs,
  } })),
}));
vi.mock('../mcp-grant', () => ({ resolveActiveMcpGrant: vi.fn(async () => false) }));
vi.mock('../tools', async () => {
  const { warpTools } = await import('../tools/warp');
  return { ALL_TOOLS: warpTools, toolByName: (name: string) => warpTools.find(tool => tool.name === name) };
});

import { handleMcpRpc } from '../server';
import { warpTools } from '../tools/warp';
import { POST as dispatchHttp } from '../../../../app/warp/api/dispatch/route';

beforeEach(() => {
  vi.clearAllMocks();
  h.credential = randomBytes(32).toString('base64url');
  h.unavailable = false;
  h.publish.mockResolvedValue(undefined);
  h.key.mockImplementation(async (ownerDid: string, caller: ConnectionCaller) => {
    expect(ownerDid).toBe(h.ownerDid);
    expect(caller).toEqual(h.caller);
    if (h.unavailable) throw new Error('custody unavailable');
    return h.credential;
  });
  h.resolve.mockImplementation(async () => ({ ownerDid: h.ownerDid, caller: h.caller }));
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true, status: 200, headers: new Headers(),
    json: async () => ({ run_id: 'test-run', state: 'QUEUED', runs: [] }),
  })));
});
afterEach(() => { vi.unstubAllGlobals(); });
function ctx(): McpToolContext {
  return { did: h.caller.actorDid, actingFor: h.ownerDid, appDid: 'did:imajin:gateway-client',
    scopes: new Set(['warp:dispatch']), authorizationId: 'att_agent' };
}
function rpc(name: string, args: Record<string, unknown> = {}) {
  return handleMcpRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, ctx());
}
function attribution() {
  const events = h.publish.mock.calls.filter(([type]) => type === 'warp.agent.dispatched');
  return events.map(([, event]) => ({
    actingDid: event.payload.actorDid, billedDid: event.payload.principalDid, issuer: event.issuer, subject: event.subject,
  }));
}
describe.each([
  { agent: 'did:imajin:jin', principal: 'did:imajin:ryan', org: false },
  { agent: 'did:imajin:artifact-jin', principal: 'did:imajin:artifact', org: true },
])('real dispatch audit parity for $agent', ({ agent, principal, org }) => {
  beforeEach(() => {
    h.ownerDid = principal;
    h.caller = { actorDid: agent, ...(org ? { actingAs: principal } : { actingFor: principal }) };
  });
  it('records the same acting and billed DIDs via MCP and the plugin HTTP twin', async () => {
    const mcp = await rpc('warp_dispatch_agent', { prompt: 'Browser testing: no\nRead-only fixture task' });
    expect(mcp).toMatchObject({ result: { isError: false } });
    const direct = await dispatchHttp(new NextRequest('http://localhost/warp/api/dispatch', {
      method: 'POST', headers: { authorization: `Bearer ${randomBytes(32).toString('base64url')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Browser testing: no\nRead-only fixture task' }),
    }));
    expect(direct.status).toBe(201);
    expect(attribution()).toEqual([
      { actingDid: agent, billedDid: principal, issuer: principal, subject: principal },
      { actingDid: agent, billedDid: principal, issuer: principal, subject: principal },
    ]);
    expect(h.resolve).toHaveBeenCalledWith(expect.objectContaining({ did: agent, actingFor: principal }), 'warp');
    expect(h.key).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(h.publish.mock.calls)).not.toContain(h.credential);
  });
  it.each([
    ['warp_get_run', { run_id: 'test-run' }],
    ['warp_list_runs', {}],
    ['warp_get_transcript', { run_id: 'test-run' }],
    ['warp_get_conversation', { run_id: 'test-run' }],
    ['warp_send_followup', { run_id: 'test-run', message: 'Continue' }],
    ['warp_cancel_run', { run_id: 'test-run' }],
  ] as const)('passes the immutable caller through %s credential access', async (name, args) => {
    await rpc(name, args);
    expect(h.resolve).toHaveBeenCalledTimes(1);
    expect(h.key).toHaveBeenCalledWith(principal, h.caller);
  });
  it('refuses the next call when custody fails and names the connector control', async () => {
    h.unavailable = true;
    const response = await rpc('warp_get_run', { run_id: 'test-run' });
    expect(response).toMatchObject({ result: { isError: true,
      content: [{ type: 'text', text: expect.stringContaining('/auth/connectors') }] } });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['actAs', 'actingAs', 'actingFor', 'acting_for', 'agent_did', 'x-acting-as'])(
    'rejects tool argument identity substitution through %s', async selector => {
      expect(await rpc('warp_dispatch_agent', { prompt: 'Task', [selector]: 'did:imajin:other-org' }))
        .toMatchObject({ result: { isError: true, content: [{ text: expect.stringContaining('agent_binding_immutable') }] } });
      expect(h.key).not.toHaveBeenCalled();
      expect(h.resolve).not.toHaveBeenCalled();
    },
  );
  it('does not accept service-key ingestion through an agent gateway token', async () => {
    const tool = warpTools.find(candidate => candidate.name === 'warp_seal_key')!;
    await expect(tool.handler({}, ctx())).rejects.toMatchObject({ code: 'agent_key_management_forbidden' });
    expect(h.key).not.toHaveBeenCalled();
  });
  it('does not run any credential boundary without the token tool scope', async () => {
    const limited = { ...ctx(), scopes: new Set(['media:read']) };
    const result = await handleMcpRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'warp_dispatch_agent', arguments: { prompt: 'Task' } } }, limited);
    expect(result).toMatchObject({ result: { isError: true } });
    expect(h.resolve).not.toHaveBeenCalled();
  });
});
