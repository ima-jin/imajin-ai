/**
 * Tests for the Warp MCP tools (#1428, #1639).
 *
 * The connector and dispatch client are mocked; their own behaviour is covered in
 * `src/lib/warp/__tests__`. What matters here is that every tool is scope-gated,
 * acts on `ctx.did` and nothing else, maps its snake_case MCP arguments onto the
 * client correctly, and never echoes the Warp Agent key.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { McpContent, McpToolContext } from '../types';
import { makeAgentRun } from '@/src/lib/warp/__tests__/run-fixture';

// ─── Mocks ─────────────────────────────────────────────────────────────────

vi.mock('@/src/lib/warp/connector', () => ({
  sealWarpAgentKey: vi.fn(),
  WARP_DISPATCH_SCOPE: 'warp:dispatch',
}));

vi.mock('@/src/lib/warp/dispatch', () => ({
  dispatchAgentRun: vi.fn(),
  getAgentRun: vi.fn(),
  getAgentRunTranscript: vi.fn(),
  getAgentRunConversation: vi.fn(),
  listAgentRuns: vi.fn(),
  cancelAgentRun: vi.fn(),
  sendFollowup: vi.fn(),
}));

// Deliberately NOT importing `../tools` (the registry): it eagerly pulls in every
// other tool module and, through them, the DB client, which needs a live
// DATABASE_URL. Registry membership is enforced by the typechecked import in
// tools/index.ts; behaviour is what is worth testing here.
import { warpTools } from '../tools/warp';
import { sealWarpAgentKey } from '@/src/lib/warp/connector';
import {
  cancelAgentRun,
  dispatchAgentRun,
  getAgentRun,
  getAgentRunConversation,
  getAgentRunTranscript,
  listAgentRuns,
  sendFollowup,
} from '@/src/lib/warp/dispatch';

// ─── Helpers ───────────────────────────────────────────────────────────────

const ctx: McpToolContext = {
  did: 'did:imajin:veteze',
  appDid: 'did:imajin:mcp-connector',
  scopes: new Set(['warp:dispatch']),
};

const AGENT_KEY = 'warp-agent-key-SUPER-SECRET-VALUE';
const RUN = makeAgentRun({ state: 'QUEUED' });
const RUN_ID = RUN.runId;

function tool(name: string) {
  const t = warpTools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
}

async function call(name: string, args: Record<string, unknown>) {
  return (await tool(name).handler(args, ctx)) as McpContent[];
}

function parseResult(content: McpContent[]) {
  return JSON.parse(content[0].text);
}

/** The input the dispatch client was called with. */
function dispatchInput(): Record<string, unknown> {
  return vi.mocked(dispatchAgentRun).mock.calls[0][1] as unknown as Record<string, unknown>;
}

/** The filters `listAgentRuns` was called with. */
function listInput(): Record<string, unknown> {
  return vi.mocked(listAgentRuns).mock.calls[0][1] as unknown as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(dispatchAgentRun).mockResolvedValue(RUN);
  vi.mocked(getAgentRun).mockResolvedValue(makeAgentRun({ state: 'SUCCEEDED' }));
  vi.mocked(getAgentRunTranscript).mockResolvedValue({
    runId: RUN_ID,
    content: 'transcript text',
    contentType: 'text/plain',
    truncated: false,
  });
  vi.mocked(getAgentRunConversation).mockResolvedValue({
    runId: RUN_ID,
    conversationId: 'conv-1',
    steps: [{ id: 'step-1', messages: [], steps: [] }],
  });
  vi.mocked(listAgentRuns).mockResolvedValue({
    runs: [RUN],
    hasNextPage: true,
    nextCursor: 'cursor-2',
  });
  vi.mocked(cancelAgentRun).mockResolvedValue({ runId: RUN_ID, cancelled: true });
  vi.mocked(sendFollowup).mockResolvedValue({ runId: RUN_ID, accepted: true });
});

// ─── Registry ──────────────────────────────────────────────────────────────

describe('registration', () => {
  it('exports the seal, dispatch, and run-surface tools', () => {
    expect(warpTools.map((t) => t.name)).toEqual([
      'warp_seal_key',
      'warp_dispatch_agent',
      'warp_get_run',
      'warp_list_runs',
      'warp_get_transcript',
      'warp_get_conversation',
      'warp_send_followup',
      'warp_cancel_run',
    ]);
  });

  it('gates every tool on warp:dispatch', () => {
    for (const t of warpTools) {
      expect(t.requiredScope).toBe('warp:dispatch');
    }
  });

  it('rejects unknown arguments on every tool schema (fail-closed)', () => {
    for (const t of warpTools) {
      expect(t.inputSchema.additionalProperties).toBe(false);
    }
  });

  it('documents every advertised argument so a caller need not guess', () => {
    for (const t of warpTools) {
      const properties = t.inputSchema.properties as Record<string, { description?: string }>;
      for (const [name, schema] of Object.entries(properties)) {
        expect(schema.description, `${t.name}.${name}`).toBeTruthy();
      }
    }
  });
});

// ─── warp_seal_key ─────────────────────────────────────────────────────────

describe('warp_seal_key', () => {
  it('seals under the caller DID and never echoes the key back', async () => {
    const res = await call('warp_seal_key', { key: AGENT_KEY });

    expect(sealWarpAgentKey).toHaveBeenCalledWith(ctx.did, AGENT_KEY);

    const out = parseResult(res);
    expect(out).toEqual({ sealed: true, did: ctx.did });
    expect(JSON.stringify(out)).not.toContain(AGENT_KEY);
  });

  it('throws without sealing when key is missing', async () => {
    await expect(tool('warp_seal_key').handler({}, ctx)).rejects.toThrow(/key is required/);
    expect(sealWarpAgentKey).not.toHaveBeenCalled();
  });
});

// ─── warp_dispatch_agent ───────────────────────────────────────────────────

describe('warp_dispatch_agent', () => {
  it('dispatches as the caller DID and returns run id, state, and session link', async () => {
    const res = await call('warp_dispatch_agent', { prompt: 'Fix the login error' });

    expect(vi.mocked(dispatchAgentRun).mock.calls[0][0]).toBe(ctx.did);
    expect(dispatchInput()).toEqual({ prompt: 'Fix the login error' });
    expect(parseResult(res)).toMatchObject({
      runId: RUN_ID,
      state: 'QUEUED',
      sessionLink: RUN.sessionLink,
      configName: 'veteze-jin',
    });
  });

  it('maps snake_case MCP arguments onto the client input', async () => {
    await call('warp_dispatch_agent', {
      prompt: 'go',
      title: 'Nightly',
      skill_spec: 'ima-jin/imajin-ai:catalyst',
      environment_id: 'UA17BXYZ',
      model_id: 'auto',
      base_prompt: 'be brief',
    });

    expect(dispatchInput()).toEqual({
      prompt: 'go',
      title: 'Nightly',
      skillSpec: 'ima-jin/imajin-ai:catalyst',
      environmentId: 'UA17BXYZ',
      modelId: 'auto',
      basePrompt: 'be brief',
    });
  });

  it('maps conversation_id/parent_run_id onto the client input (#1939)', async () => {
    await call('warp_dispatch_agent', {
      prompt: 'go',
      conversation_id: 'conv-123',
      parent_run_id: 'run-parent-1',
    });

    expect(dispatchInput()).toEqual({
      prompt: 'go',
      conversationId: 'conv-123',
      parentRunId: 'run-parent-1',
    });
  });

  it('passes an mcp_servers map through and honours attach_imajin_mcp', async () => {
    await call('warp_dispatch_agent', {
      prompt: 'go',
      attach_imajin_mcp: true,
      mcp_servers: { imajin: { url: 'https://mcp.example/mcp' } },
    });

    expect(dispatchInput()).toMatchObject({
      attachImajinMcp: true,
      mcpServers: { imajin: { url: 'https://mcp.example/mcp' } },
    });
  });

  it('ignores an mcp_servers argument that is not a map', async () => {
    await call('warp_dispatch_agent', { prompt: 'go', mcp_servers: ['nope'] });
    expect(dispatchInput()).not.toHaveProperty('mcpServers');
  });

  it('omits attach_imajin_mcp when it is not a boolean, rather than coercing', async () => {
    await call('warp_dispatch_agent', { prompt: 'go', attach_imajin_mcp: 'yes' });
    expect(dispatchInput()).not.toHaveProperty('attachImajinMcp');
  });

  it('throws without dispatching when prompt is missing', async () => {
    await expect(tool('warp_dispatch_agent').handler({}, ctx)).rejects.toThrow(/prompt is required/);
    expect(dispatchAgentRun).not.toHaveBeenCalled();
  });

  it('propagates a fail-closed gate error instead of reporting success', async () => {
    vi.mocked(dispatchAgentRun).mockRejectedValueOnce(new Error('warp_no_grant: nope'));
    await expect(tool('warp_dispatch_agent').handler({ prompt: 'go' }, ctx)).rejects.toThrow(
      /warp_no_grant/,
    );
  });
});

// ─── warp_get_run ──────────────────────────────────────────────────────────

describe('warp_get_run', () => {
  it('reads the run as the caller DID', async () => {
    const res = await call('warp_get_run', { run_id: RUN_ID });

    expect(getAgentRun).toHaveBeenCalledWith(ctx.did, RUN_ID);
    expect(parseResult(res)).toMatchObject({ state: 'SUCCEEDED' });
  });

  it('returns the expanded run detail — timing, cost, and artifacts (#1639)', async () => {
    vi.mocked(getAgentRun).mockResolvedValueOnce(
      makeAgentRun({
        state: 'FAILED',
        runTime: 'PT2M30S',
        startedAt: '2026-08-06T02:00:00Z',
        statusMessage: { message: 'sandbox died', errorCode: 'sandbox_error', retryable: true },
        requestUsage: { inferenceCost: 12, computeCost: 3, platformCost: 1 },
        artifacts: [
          {
            artifactType: 'PULL_REQUEST',
            createdAt: '2026-08-06T02:01:00Z',
            data: { url: 'https://github.com/ima-jin/imajin-ai/pull/1', branch: 'feat/x' },
          },
        ],
      }),
    );

    expect(parseResult(await call('warp_get_run', { run_id: RUN_ID }))).toMatchObject({
      state: 'FAILED',
      runTime: 'PT2M30S',
      startedAt: '2026-08-06T02:00:00Z',
      statusMessage: { errorCode: 'sandbox_error', retryable: true },
      requestUsage: { inferenceCost: 12, computeCost: 3, platformCost: 1 },
      artifacts: [
        {
          artifactType: 'PULL_REQUEST',
          data: { url: 'https://github.com/ima-jin/imajin-ai/pull/1', branch: 'feat/x' },
        },
      ],
    });
  });

  it('throws without a lookup when run_id is missing', async () => {
    await expect(tool('warp_get_run').handler({}, ctx)).rejects.toThrow(/run_id is required/);
    expect(getAgentRun).not.toHaveBeenCalled();
  });
});

// ─── warp_list_runs ────────────────────────────────────────────────────────

describe('warp_list_runs', () => {
  it('lists as the caller DID with no filters when none are given', async () => {
    const res = await call('warp_list_runs', {});

    expect(vi.mocked(listAgentRuns).mock.calls[0][0]).toBe(ctx.did);
    expect(listInput()).toEqual({});
    expect(parseResult(res)).toMatchObject({
      hasNextPage: true,
      nextCursor: 'cursor-2',
      runs: [{ runId: RUN_ID }],
    });
  });

  it('maps snake_case filters onto the client input', async () => {
    await call('warp_list_runs', {
      name: 'veteze-jin',
      state: 'INPROGRESS',
      environment_id: 'UA17BXYZ',
      created_after: '2026-08-01T00:00:00Z',
      limit: 50,
      cursor: 'cursor-1',
    });

    expect(listInput()).toEqual({
      name: 'veteze-jin',
      states: ['INPROGRESS'],
      environmentId: 'UA17BXYZ',
      createdAfter: '2026-08-01T00:00:00Z',
      limit: 50,
      cursor: 'cursor-1',
    });
  });

  it('accepts a list of states, matching any of them', async () => {
    await call('warp_list_runs', { state: ['QUEUED', ' INPROGRESS '] });
    expect(listInput()).toEqual({ states: ['QUEUED', 'INPROGRESS'] });
  });

  it('drops non-string and blank state entries instead of failing the list', async () => {
    await call('warp_list_runs', { state: ['QUEUED', 7, '', null] });
    expect(listInput()).toEqual({ states: ['QUEUED'] });
  });

  it('omits state entirely when the argument carries no usable value', async () => {
    await call('warp_list_runs', { state: 42 });
    expect(listInput()).not.toHaveProperty('states');
  });

  it('omits a non-numeric limit rather than coercing it', async () => {
    await call('warp_list_runs', { limit: '50' });
    expect(listInput()).not.toHaveProperty('limit');
  });

  it('maps ancestor_run_id onto the client input (#1939)', async () => {
    await call('warp_list_runs', { ancestor_run_id: 'run-ancestor-1' });
    expect(listInput()).toEqual({ ancestorRunId: 'run-ancestor-1' });
  });
});

// ─── warp_get_transcript ───────────────────────────────────────────────────

describe('warp_get_transcript', () => {
  it('reads the transcript as the caller DID, with no cap by default', async () => {
    const res = await call('warp_get_transcript', { run_id: RUN_ID });

    expect(getAgentRunTranscript).toHaveBeenCalledWith(ctx.did, RUN_ID, {});
    expect(parseResult(res)).toEqual({
      runId: RUN_ID,
      content: 'transcript text',
      contentType: 'text/plain',
      truncated: false,
    });
  });

  it('passes max_chars through as the cap', async () => {
    await call('warp_get_transcript', { run_id: RUN_ID, max_chars: 1000 });
    expect(getAgentRunTranscript).toHaveBeenCalledWith(ctx.did, RUN_ID, { maxChars: 1000 });
  });

  it('ignores a non-numeric max_chars rather than coercing it', async () => {
    await call('warp_get_transcript', { run_id: RUN_ID, max_chars: 'lots' });
    expect(getAgentRunTranscript).toHaveBeenCalledWith(ctx.did, RUN_ID, {});
  });

  it('throws without a read when run_id is missing', async () => {
    await expect(tool('warp_get_transcript').handler({}, ctx)).rejects.toThrow(
      /run_id is required/,
    );
    expect(getAgentRunTranscript).not.toHaveBeenCalled();
  });
});

// ─── warp_get_conversation ─────────────────────────────────────────────────

describe('warp_get_conversation', () => {
  it('reads the conversation as the caller DID', async () => {
    const res = await call('warp_get_conversation', { run_id: RUN_ID });

    expect(getAgentRunConversation).toHaveBeenCalledWith(ctx.did, RUN_ID);
    expect(parseResult(res)).toMatchObject({
      conversationId: 'conv-1',
      steps: [{ id: 'step-1' }],
    });
  });

  it('throws without a read when run_id is missing', async () => {
    await expect(tool('warp_get_conversation').handler({}, ctx)).rejects.toThrow(
      /run_id is required/,
    );
    expect(getAgentRunConversation).not.toHaveBeenCalled();
  });
});

// ─── warp_send_followup ────────────────────────────────────────────────────

describe('warp_send_followup', () => {
  it('sends as the caller DID and reports acceptance', async () => {
    const res = await call('warp_send_followup', { run_id: RUN_ID, message: 'use the v2 API' });

    expect(sendFollowup).toHaveBeenCalledWith(ctx.did, RUN_ID, { message: 'use the v2 API' });
    expect(parseResult(res)).toEqual({ runId: RUN_ID, accepted: true });
  });

  it('passes an explicit mode through', async () => {
    await call('warp_send_followup', { run_id: RUN_ID, message: 'rethink it', mode: 'plan' });
    expect(sendFollowup).toHaveBeenCalledWith(ctx.did, RUN_ID, {
      message: 'rethink it',
      mode: 'plan',
    });
  });

  it('forwards an unknown mode so the client owns the closed set', async () => {
    vi.mocked(sendFollowup).mockRejectedValueOnce(new Error('warp_invalid_mode: nope'));
    await expect(
      tool('warp_send_followup').handler({ run_id: RUN_ID, message: 'go', mode: 'nope' }, ctx),
    ).rejects.toThrow(/warp_invalid_mode/);
  });

  it('throws without sending when message is missing', async () => {
    await expect(tool('warp_send_followup').handler({ run_id: RUN_ID }, ctx)).rejects.toThrow(
      /message is required/,
    );
    expect(sendFollowup).not.toHaveBeenCalled();
  });

  it('throws without sending when run_id is missing', async () => {
    await expect(tool('warp_send_followup').handler({ message: 'go' }, ctx)).rejects.toThrow(
      /run_id is required/,
    );
    expect(sendFollowup).not.toHaveBeenCalled();
  });

  it('passes an explicit resume through (#1939)', async () => {
    await call('warp_send_followup', { run_id: RUN_ID, message: 'keep going', resume: true });
    expect(sendFollowup).toHaveBeenCalledWith(ctx.did, RUN_ID, {
      message: 'keep going',
      resume: true,
    });
  });

  it('omits resume entirely when the caller names none', async () => {
    await call('warp_send_followup', { run_id: RUN_ID, message: 'go' });
    expect(sendFollowup).toHaveBeenCalledWith(ctx.did, RUN_ID, { message: 'go' });
  });

  it('surfaces a terminal-run refusal instead of reporting acceptance (#1939)', async () => {
    vi.mocked(sendFollowup).mockRejectedValueOnce(
      new Error('warp_run_terminal: run has already ended'),
    );
    await expect(
      tool('warp_send_followup').handler({ run_id: RUN_ID, message: 'go' }, ctx),
    ).rejects.toThrow(/warp_run_terminal/);
  });
});

// ─── warp_cancel_run ───────────────────────────────────────────────────────

describe('warp_cancel_run', () => {
  it('cancels as the caller DID', async () => {
    const res = await call('warp_cancel_run', { run_id: RUN_ID });

    expect(cancelAgentRun).toHaveBeenCalledWith(ctx.did, RUN_ID);
    expect(parseResult(res)).toEqual({ runId: RUN_ID, cancelled: true });
  });

  it('surfaces a refusal instead of reporting a cancellation that did not happen', async () => {
    vi.mocked(cancelAgentRun).mockRejectedValueOnce(
      new Error('warp_api_error: 400 run already terminal'),
    );
    await expect(tool('warp_cancel_run').handler({ run_id: RUN_ID }, ctx)).rejects.toThrow(
      /already terminal/,
    );
  });

  it('throws without cancelling when run_id is missing', async () => {
    await expect(tool('warp_cancel_run').handler({}, ctx)).rejects.toThrow(/run_id is required/);
    expect(cancelAgentRun).not.toHaveBeenCalled();
  });
});
