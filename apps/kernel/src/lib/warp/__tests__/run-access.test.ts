import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { ConnectionCaller } from '@/src/lib/kernel/connection-principal-policy';

const h = vi.hoisted(() => ({
  sql: vi.fn(), key: vi.fn(), emit: vi.fn(), publish: vi.fn(), resolvePrincipal: vi.fn(), lookup: vi.fn(),
  identity: { id: 'did:member-a', actingAs: undefined as string | undefined },
}));
vi.mock('@imajin/db', () => ({ getClient: () => h.sql }));
vi.mock('@/src/lib/vault/sealing', () => ({ getNodeSigningIdentity: () => ({ senderDid: 'did:node' }) }));
vi.mock('@/src/lib/kernel/connection-principal', () => ({ resolveConnectionPrincipal: h.resolvePrincipal }));
vi.mock('@/src/lib/kernel/lookup', () => ({ lookupIdentity: h.lookup }));
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeDid: async () => 'did:node' }));
vi.mock('../connector', () => ({ requireAgentKey: h.key, WARP_DISPATCH_SCOPE: 'warp:dispatch', sealWarpAgentKey: vi.fn() }));
vi.mock('../environment', () => ({ readEnvironmentId: async () => undefined }));
vi.mock('../loop-emit', () => ({ emitWarpRunLoopEvent: h.emit }));
vi.mock('../brief-ledger', () => ({ recordWarpBrief: async () => ({ hash: 'a'.repeat(64), storage: 'hash-only', assetId: null }) }));
vi.mock('../run-watch-sweep', () => ({ claimTerminalPublish: vi.fn(), countPriorResumes: async () => 0 }));
vi.mock('@imajin/bus', () => ({ publish: h.publish }));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('@/src/lib/kernel/cors', () => ({ corsHeaders: () => ({}), corsOptions: () => new Response(null, { status: 204 }) }));
vi.mock('@imajin/auth', async importOriginal => ({
  ...await importOriginal<typeof import('@imajin/auth')>(),
  requireAuth: async () => ({ identity: h.identity }),
  resolveActingDid: (identity: { id: string }) => identity.id,
}));

import { assertRunAccess, canAccessRun, dispatchRunAttribution, nodeRunCaller, readRunReceipt, runCredentialCaller } from '../run-access';
import { WarpRunAccessError } from '../errors';
import { cancelAgentRun, dispatchAgentRun, getAgentRun, getAgentRunConversation, getAgentRunTranscript, listAgentRuns, publishBlockedRunOutcome, publishTerminalRunOutcome, publishTimeoutRunOutcome, sendFollowup, watchRun } from '../dispatch';
import { GET as httpGet } from '../../../../app/warp/api/runs/[runId]/route';
import { GET as httpList } from '../../../../app/warp/api/runs/route';
import { GET as httpTranscript } from '../../../../app/warp/api/runs/[runId]/transcript/route';
import { GET as httpConversation } from '../../../../app/warp/api/runs/[runId]/conversation/route';
import { POST as httpCancel } from '../../../../app/warp/api/runs/[runId]/cancel/route';
import { POST as httpFollowup } from '../../../../app/warp/api/runs/[runId]/followups/route';
import { warpTools } from '../../mcp/tools/warp';
import { makeAgentRun } from './run-fixture';

const ORG = 'did:org';
const A = 'did:member-a';
const B = 'did:member-b';
const BOT = 'did:org-bot';
type ReceiptRow = { principal: string; parent_loop_id: string | null; payload: Record<string, unknown> };
const rows = new Map<string, ReceiptRow>();
const caller = (actorDid: string): ConnectionCaller => ({ actorDid, actingAs: ORG });
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

function receipt(runId: string, principal = ORG, actor: string | undefined = A, parent: string | null = null) {
  rows.set(runId, { principal, parent_loop_id: parent, payload: {
    principal, actorDid: actor, orgDid: ORG, parentLoopId: parent,
  } });
}
function tool(name: string) {
  const found = warpTools.find(entry => entry.name === name);
  if (!found) throw new Error('Missing test tool');
  return found;
}
function ctx(actorDid: string) {
  return { did: actorDid, credentialDid: ORG, appDid: 'did:app', scopes: new Set(['warp:dispatch']), connectionCaller: caller(actorDid) };
}
function req(path = '', body?: unknown) {
  return new NextRequest(`https://kernel.test/warp/api/runs${path}`, body ? {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  } : {});
}
const params = (runId: string) => ({ params: Promise.resolve({ runId }) });

beforeEach(() => {
  vi.clearAllMocks();
  rows.clear();
  receipt('run-a');
  receipt('run-b', ORG, B);
  receipt('child', 'did:child-principal', BOT, 'run-a');
  h.sql.mockImplementation(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
    const row = rows.get(values.at(-1) as string);
    return row ? [row] : [];
  });
  h.lookup.mockResolvedValue({ handle: 'org', scope: 'business' });
  h.resolvePrincipal.mockResolvedValue({ ownerDid: ORG, orgContext: { orgDid: ORG } });
  h.key.mockResolvedValue('fixture-credential');
  h.emit.mockResolvedValue(true);
  h.publish.mockResolvedValue(undefined);
  h.identity = { id: A, actingAs: ORG };
  vi.stubEnv('WARP_API_BASE_URL', 'https://warp.test/api/v1');
  vi.stubGlobal('fetch', vi.fn(async () => response({ run_id: 'run-a', state: 'INPROGRESS' })));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('original signed dispatch authority', () => {
  it('requires signed-ingest ID, node witness, original dispatch, kind, principal and run bindings in SQL', async () => {
    await readRunReceipt('run-a');
    const [strings, ...bindings] = h.sql.mock.calls[0];
    const query = strings.join('?');
    for (const fragment of [
      "e.id ~ '^signed-loop:[0-9a-f]{64}$'", "e.type = 'loop.started'",
      'e.issuer = ?', "e.payload->>'kind' = 'warp.run'", "l.kind = 'warp.run'",
      "e.payload->>'loopId' = l.loop_id", "e.payload->'refs'->>'runId' = l.loop_id",
      "e.payload->>'principal' = l.principal", 'e.principal = l.principal',
      'ORDER BY e.occurred_at, e.id LIMIT 1',
    ]) expect(query).toContain(fragment);
    expect(bindings).toEqual(['did:node', 'run-a']);
  });

  it.each([ORG, A])('allows named principal or actor %s', async did => {
    await expect(assertRunAccess(did, 'run-a')).resolves.toMatchObject({ principalDid: ORG, actorDid: A });
  });
  it('allows the owner of a recorded ancestor, not an unrelated org member', async () => {
    await expect(assertRunAccess(ORG, 'child', caller(A))).resolves.toMatchObject({ actorDid: BOT });
    await expect(assertRunAccess(ORG, 'child', caller(B))).rejects.toBeInstanceOf(WarpRunAccessError);
  });
  it('does not promote an acting-as-org member to the org principal', async () => {
    await expect(assertRunAccess(ORG, 'run-a', caller(A))).resolves.toBeDefined();
    await expect(assertRunAccess(ORG, 'run-a', caller(B))).rejects.toMatchObject({ status: 403, message: 'warp_run_forbidden' });
  });
  it('keeps legacy actor-less dispatches principal-only even after a later actor observation', async () => {
    receipt('legacy', ORG, undefined);
    rows.get('legacy')!.payload.actorDid = undefined;
    await expect(assertRunAccess(ORG, 'legacy')).resolves.toBeDefined();
    await expect(assertRunAccess(ORG, 'legacy', caller(A))).rejects.toBeInstanceOf(WarpRunAccessError);
  });
  it('fails closed on absent projection/dispatch or inconsistent principal data', async () => {
    await expect(assertRunAccess(ORG, 'missing')).rejects.toBeInstanceOf(WarpRunAccessError);
    rows.set('bad', { principal: 12 as unknown as string, parent_loop_id: null, payload: {} });
    expect(await readRunReceipt('bad')).toBeNull();
  });
  it('rejects a projection lineage graft not present in the dispatch receipt', async () => {
    rows.get('run-b')!.parent_loop_id = 'run-a';
    await expect(assertRunAccess(ORG, 'run-b', caller(A))).rejects.toBeInstanceOf(WarpRunAccessError);
  });
  it.each(['cycle', 'missing-parent', 'depth'])('bounds an unowned %s lineage without granting access', async shape => {
    if (shape === 'cycle') {
      receipt('run-b', ORG, B, 'child-b');
      receipt('child-b', ORG, B, 'run-b');
    } else if (shape === 'missing-parent') receipt('run-b', ORG, B, 'missing');
    else for (let i = 0; i < 66; i += 1) receipt(i ? `depth-${i}` : 'run-b', ORG, B, `depth-${i + 1}`);
    await expect(assertRunAccess(ORG, 'run-b', caller(A))).rejects.toBeInstanceOf(WarpRunAccessError);
    expect(h.sql.mock.calls.length).toBeLessThanOrEqual(65);
  });
  it('never caches authority and propagates storage faults without an allow', async () => {
    expect(await canAccessRun(ORG, 'run-a', caller(A))).toBe(true);
    rows.clear();
    expect(await canAccessRun(ORG, 'run-a', caller(A))).toBe(false);
    h.sql.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(canAccessRun(ORG, 'run-a', caller(A))).rejects.toThrow('storage unavailable');
  });
  it('requires the explicit node capability, correct principal and an existing receipt for system access', async () => {
    const system = nodeRunCaller();
    expect(runCredentialCaller(system)).toBeUndefined();
    expect(runCredentialCaller(caller(A))).toEqual(caller(A));
    await expect(assertRunAccess(ORG, 'run-a', system)).resolves.toBeDefined();
    await expect(assertRunAccess('did:other', 'run-a', system)).rejects.toBeInstanceOf(WarpRunAccessError);
    await expect(assertRunAccess(ORG, 'missing', system)).rejects.toBeInstanceOf(WarpRunAccessError);
    await expect(assertRunAccess(ORG, 'run-a', { actorDid: 'did:node' })).rejects.toBeInstanceOf(WarpRunAccessError);
  });
});

const operations = [
  ['get', (id: string, who: ConnectionCaller) => getAgentRun(ORG, id, who)],
  ['followup', (id: string, who: ConnectionCaller) => sendFollowup(ORG, id, { message: 'continue' }, who)],
  ['cancel', (id: string, who: ConnectionCaller) => cancelAgentRun(ORG, id, who)],
  ['transcript', (id: string, who: ConnectionCaller) => getAgentRunTranscript(ORG, id, {}, who)],
  ['conversation', (id: string, who: ConnectionCaller) => getAgentRunConversation(ORG, id, who)],
] as const;

describe('all dispatch operations share the receipt boundary', () => {
  it.each(operations)('%s refuses another member and a missing receipt before unwrapping or any upstream call', async (_name, operation) => {
    for (const id of ['run-a', 'missing']) {
      await expect(operation(id, caller(B))).rejects.toMatchObject({ status: 403, message: 'warp_run_forbidden' });
    }
    expect(h.key).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(operations)('%s permits principal, actor and ancestor owner', async (_name, operation) => {
    for (const [id, who] of [['run-a', { actorDid: ORG }], ['run-a', caller(A)], ['child', caller(A)]] as const) {
      await expect(operation(id, who)).resolves.toBeDefined();
    }
  });
  it('permits a personal receipt only in that personal identity context', async () => {
    receipt('personal', A, A);
    await expect(getAgentRun(A, 'personal')).resolves.toBeDefined();
    await expect(getAgentRun(B, 'personal')).rejects.toBeInstanceOf(WarpRunAccessError);
  });
  it('filters list results by receipts and verifies ancestor descendants locally', async () => {
    vi.mocked(fetch).mockImplementation(async () => response({ runs: ['run-a', 'run-b', 'child', 'missing'].map(run_id => ({ run_id })) }));
    expect((await listAgentRuns(ORG, {}, caller(B))).runs.map(run => run.runId)).toEqual(['run-b']);
    expect((await listAgentRuns(ORG, { ancestorRunId: 'run-a' }, caller(A))).runs.map(run => run.runId)).toEqual(['child']);
    vi.mocked(fetch).mockClear();
    await expect(listAgentRuns(ORG, { ancestorRunId: 'run-a' }, caller(B))).rejects.toBeInstanceOf(WarpRunAccessError);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('refuses parent and conversation-only dispatch before any upstream call', async () => {
    await expect(dispatchAgentRun(ORG, { prompt: 'go', parentRunId: 'run-a' }, caller(B))).rejects.toBeInstanceOf(WarpRunAccessError);
    await expect(dispatchAgentRun(ORG, { prompt: 'go', conversationId: 'foreign-conversation' }, caller(B))).rejects.toBeInstanceOf(WarpRunAccessError);
    expect(fetch).not.toHaveBeenCalled();
    expect(h.key).not.toHaveBeenCalled();
  });
  it('refuses a conversation not belonging to the authorized parent without dispatching', async () => {
    await expect(dispatchAgentRun(ORG, { prompt: 'go', parentRunId: 'run-a', conversationId: 'foreign' }, caller(A))).rejects.toBeInstanceOf(WarpRunAccessError);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls[0][1]?.method).toBe('GET');
  });
  it('accepts owned parent/conversation continuation and stamps the verified member/org attribution', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ run_id: 'run-a', conversation_id: 'conversation-a' }))
      .mockResolvedValueOnce(response({ run_id: 'new', parent_run_id: 'run-a' }));
    await dispatchAgentRun(ORG, { prompt: 'go', parentRunId: 'run-a', conversationId: 'conversation-a' }, caller(A));
    expect(h.emit).toHaveBeenCalledWith(expect.objectContaining({ actorDid: A, orgDid: ORG, principalDid: ORG, parentRunId: 'run-a' }));
  });
  it('unwraps a system credential only after the receipt gate', async () => {
    await getAgentRun(ORG, 'run-a', nodeRunCaller());
    expect(h.key).toHaveBeenCalledWith(ORG);
  });
});

describe('attribution survives every emitted lifecycle and sweep', () => {
  it('reuses ConnectionCaller resolution for members and org bots; personal keys have no org', async () => {
    for (const actor of [A, BOT]) {
      expect(await dispatchRunAttribution(ORG, caller(actor))).toEqual({ actorDid: actor, orgDid: ORG });
      expect(h.resolvePrincipal).toHaveBeenLastCalledWith(caller(actor), 'warp');
    }
    h.resolvePrincipal.mockResolvedValueOnce({ ownerDid: A });
    expect(await dispatchRunAttribution(A, { actorDid: A })).toEqual({ actorDid: A });
    h.lookup.mockResolvedValueOnce({ scope: 'actor' });
    expect(await dispatchRunAttribution(A)).toEqual({ actorDid: A });
    expect(await dispatchRunAttribution(ORG)).toEqual({ actorDid: ORG, orgDid: ORG });
    await expect(dispatchRunAttribution('did:wrong', caller(A))).rejects.toBeInstanceOf(WarpRunAccessError);
  });
  it('copies original actor/org on progress, blocked, completed, failed, timeout and followups, never the node DID', async () => {
    const run = makeAgentRun({ runId: 'run-a', state: 'BLOCKED' });
    await publishBlockedRunOutcome(ORG, run);
    await publishTerminalRunOutcome(ORG, run, 'SUCCEEDED');
    await publishTerminalRunOutcome(ORG, run, 'FAILED');
    await publishTimeoutRunOutcome(ORG, 'run-a', 'INPROGRESS');
    await sendFollowup(ORG, 'run-a', { message: 'continue' }, caller(A));
    vi.mocked(fetch).mockResolvedValueOnce(response({ run_id: 'run-a', state: 'SUCCEEDED' })).mockResolvedValueOnce(response({}));
    await sendFollowup(ORG, 'run-a', { message: 'resume', resume: true }, caller(A));
    vi.mocked(fetch).mockImplementation(async url => response(String(url).endsWith('/conversation')
      ? { steps: [] } : { run_id: 'run-a', state: 'INPROGRESS' }));
    let polls = 0;
    await watchRun(ORG, 'run-a', { caller: caller(A), sleep: async () => {
      if (++polls === 2) vi.mocked(fetch).mockResolvedValue(response({ run_id: 'run-a', state: 'SUCCEEDED' }));
    } });
    expect(h.emit.mock.calls.map(([event]) => event.type)).toEqual(expect.arrayContaining(['loop.started', 'loop.progress', 'loop.blocked', 'loop.finished']));
    for (const [event] of h.emit.mock.calls) expect(event).toMatchObject({ principalDid: ORG, actorDid: A, orgDid: ORG });
  });
  it('never invents a lifecycle receipt without the dispatch record', async () => {
    await publishTimeoutRunOutcome(ORG, 'missing', 'UNKNOWN');
    expect(h.emit).not.toHaveBeenCalled();
  });
});

describe('HTTP and MCP reach the same real gate', () => {
  const handlers = [httpGet, httpCancel, httpTranscript, httpConversation, httpFollowup];
  it.each(handlers)('HTTP returns the same detail-free 403 for a stranger and an absent receipt', async handler => {
    h.identity = { id: B, actingAs: ORG };
    for (const id of ['run-a', 'missing']) {
      const result = await handler(req(`/${id}`, { message: 'continue' }), params(id));
      expect(result.status).toBe(403);
      expect(await result.json()).toEqual({ error: 'warp_run_forbidden' });
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['warp_get_run', 'warp_cancel_run', 'warp_get_transcript', 'warp_get_conversation', 'warp_send_followup'])('MCP %s refuses the same identities without upstream access', async name => {
    for (const id of ['run-a', 'missing']) {
      await expect(tool(name).handler({ run_id: id, message: 'continue' }, ctx(B))).rejects.toMatchObject({ status: 403, message: 'warp_run_forbidden' });
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it('HTTP and MCP return only visible runs and refuse foreign ancestor filters', async () => {
    h.identity = { id: B, actingAs: ORG };
    vi.mocked(fetch).mockImplementation(async () => response({ runs: [{ run_id: 'run-a' }, { run_id: 'run-b' }] }));
    const listed = await httpList(req());
    expect((await listed.json()).runs.map((run: { runId: string }) => run.runId)).toEqual(['run-b']);
    const mcp = await tool('warp_list_runs').handler({}, ctx(B));
    expect(JSON.parse(mcp[0].text!).runs.map((run: { runId: string }) => run.runId)).toEqual(['run-b']);
    expect((await httpList(req('?ancestorRunId=run-a'))).status).toBe(403);
    await expect(tool('warp_list_runs').handler({ ancestor_run_id: 'run-a' }, ctx(B))).rejects.toBeInstanceOf(WarpRunAccessError);
  });
});
