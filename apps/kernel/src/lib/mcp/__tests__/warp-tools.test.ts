/**
 * Tests for the Warp MCP tools (#1428).
 *
 * The connector and dispatch client are mocked; their own behaviour is covered in
 * `src/lib/warp/__tests__`. What matters here is that every tool is scope-gated,
 * acts on `ctx.did` and nothing else, maps its snake_case MCP arguments onto the
 * client correctly, and never echoes the Warp Agent key.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { McpContent, McpToolContext } from '../types';

// ─── Mocks ─────────────────────────────────────────────────────────────────

vi.mock('@/src/lib/warp/connector', () => ({
  sealWarpAgentKey: vi.fn(),
  WARP_DISPATCH_SCOPE: 'warp:dispatch',
}));

vi.mock('@/src/lib/warp/dispatch', () => ({
  dispatchAgentRun: vi.fn(),
  getAgentRun: vi.fn(),
}));

// Deliberately NOT importing `../tools` (the registry): it eagerly pulls in every
// other tool module and, through them, the DB client, which needs a live
// DATABASE_URL. Registry membership is enforced by the typechecked import in
// tools/index.ts; behaviour is what is worth testing here.
import { warpTools } from '../tools/warp';
import { sealWarpAgentKey } from '@/src/lib/warp/connector';
import { dispatchAgentRun, getAgentRun } from '@/src/lib/warp/dispatch';

// ─── Helpers ───────────────────────────────────────────────────────────────

const ctx: McpToolContext = {
  did: 'did:imajin:veteze',
  appDid: 'did:imajin:mcp-connector',
  scopes: new Set(['warp:dispatch']),
};

const AGENT_KEY = 'warp-agent-key-SUPER-SECRET-VALUE';
const RUN = {
  runId: '019f9990-2a46-7552-b177-3a23b17eef2e',
  state: 'QUEUED',
  sessionLink: 'https://app.warp.dev/session/abc',
  title: null,
  configName: 'veteze-jin',
};

function tool(name: string) {
  const t = warpTools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
}

function parseResult(content: McpContent[]) {
  return JSON.parse(content[0].text);
}

/** The input the dispatch client was called with. */
function dispatchInput(): Record<string, unknown> {
  return vi.mocked(dispatchAgentRun).mock.calls[0][1] as unknown as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(dispatchAgentRun).mockResolvedValue(RUN);
  vi.mocked(getAgentRun).mockResolvedValue({ ...RUN, state: 'SUCCEEDED' });
});

// ─── Registry ──────────────────────────────────────────────────────────────

describe('registration', () => {
  it('exports exactly the three warp tools', () => {
    expect(warpTools.map((t) => t.name)).toEqual([
      'warp_seal_key',
      'warp_dispatch_agent',
      'warp_get_run',
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
});

// ─── warp_seal_key ─────────────────────────────────────────────────────────

describe('warp_seal_key', () => {
  it('seals under the caller DID and never echoes the key back', async () => {
    const res = await tool('warp_seal_key').handler({ key: AGENT_KEY }, ctx);

    expect(sealWarpAgentKey).toHaveBeenCalledWith(ctx.did, AGENT_KEY);

    const out = parseResult(res as McpContent[]);
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
    const res = await tool('warp_dispatch_agent').handler({ prompt: 'Fix the login error' }, ctx);

    expect(vi.mocked(dispatchAgentRun).mock.calls[0][0]).toBe(ctx.did);
    expect(dispatchInput()).toEqual({ prompt: 'Fix the login error' });
    expect(parseResult(res as McpContent[])).toMatchObject({
      runId: RUN.runId,
      state: 'QUEUED',
      sessionLink: RUN.sessionLink,
      configName: 'veteze-jin',
    });
  });

  it('maps snake_case MCP arguments onto the client input', async () => {
    await tool('warp_dispatch_agent').handler(
      {
        prompt: 'go',
        title: 'Nightly',
        skill_spec: 'ima-jin/imajin-ai:catalyst',
        environment_id: 'UA17BXYZ',
        model_id: 'auto',
        base_prompt: 'be brief',
      },
      ctx,
    );

    expect(dispatchInput()).toEqual({
      prompt: 'go',
      title: 'Nightly',
      skillSpec: 'ima-jin/imajin-ai:catalyst',
      environmentId: 'UA17BXYZ',
      modelId: 'auto',
      basePrompt: 'be brief',
    });
  });

  it('passes an mcp_servers map through and honours attach_imajin_mcp', async () => {
    await tool('warp_dispatch_agent').handler(
      {
        prompt: 'go',
        attach_imajin_mcp: true,
        mcp_servers: { imajin: { url: 'https://mcp.example/mcp' } },
      },
      ctx,
    );

    expect(dispatchInput()).toMatchObject({
      attachImajinMcp: true,
      mcpServers: { imajin: { url: 'https://mcp.example/mcp' } },
    });
  });

  it('ignores an mcp_servers argument that is not a map', async () => {
    await tool('warp_dispatch_agent').handler({ prompt: 'go', mcp_servers: ['nope'] }, ctx);
    expect(dispatchInput()).not.toHaveProperty('mcpServers');
  });

  it('omits attach_imajin_mcp when it is not a boolean, rather than coercing', async () => {
    await tool('warp_dispatch_agent').handler({ prompt: 'go', attach_imajin_mcp: 'yes' }, ctx);
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
    const res = await tool('warp_get_run').handler({ run_id: RUN.runId }, ctx);

    expect(getAgentRun).toHaveBeenCalledWith(ctx.did, RUN.runId);
    expect(parseResult(res as McpContent[])).toMatchObject({ state: 'SUCCEEDED' });
  });

  it('throws without a lookup when run_id is missing', async () => {
    await expect(tool('warp_get_run').handler({}, ctx)).rejects.toThrow(/run_id is required/);
    expect(getAgentRun).not.toHaveBeenCalled();
  });
});
