/**
 * MCP Warp Cloud Agent tools (#1428).
 *
 * Adds `warp_*` tools to the MCP registry. All tools act on behalf of `ctx.did`
 * (the resource-owner DID from the OAuth access token); no tool can reach a
 * different DID's vault, grant, or runs — the vault field name encodes the DID
 * and the run is only visible to the key that created it.
 *
 * This is the agent-to-agent wire: a `{username}-jin` speaking MCP dispatches a
 * Warp cloud agent under its own sealed credential, so the spawned run is
 * attributed to that jin's service account rather than to a human.
 *
 * `warp_seal_key`: takes the Warp Agent key and seals it immediately as a v2
 * delegation-grant vault field. The key is NEVER logged, NEVER echoed back,
 * NEVER returned.
 *
 * Template: modelled on tools/discord.ts.
 * RFC-32 federated-growth contract: only this file + tools/index.ts change.
 */
import type { McpTool } from '../types';
import { str, json } from './utils';
import { sealWarpAgentKey, WARP_DISPATCH_SCOPE } from '@/src/lib/warp/connector';
import { dispatchAgentRun, getAgentRun, type WarpMcpServerConfig } from '@/src/lib/warp/dispatch';

// ── Key ingestion ─────────────────────────────────────────────────────────────

const sealKeyTool: McpTool = {
  name: 'warp_seal_key',
  requiredScope: WARP_DISPATCH_SCOPE,
  description:
    'Seal your Warp Agent key in the Imajin vault so warp_dispatch_agent can spawn ' +
    'Warp cloud agents under your own credential. The key is encrypted immediately on ' +
    'receipt as a revocable delegation grant, and is never logged, echoed, or returned. ' +
    'Run this once; re-run to rotate. Revoking the grant kills dispatch without ' +
    'rotating the key. Requires an active warp:dispatch grant in your scope-manifest.',
  inputSchema: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        description: 'Your Warp Agent API key (Warp Settings → Platform)',
      },
    },
    required: ['key'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const key = str(args, 'key');
    if (key === undefined) throw new Error('key is required');

    await sealWarpAgentKey(ctx.did, key);

    // Do NOT echo the key or any derivative. Return only a safe confirmation.
    return json({ sealed: true, did: ctx.did });
  },
};

// ── Dispatch ──────────────────────────────────────────────────────────────────

/** Read the optional `mcp_servers` map, ignoring a non-object argument. */
function mcpServersArg(args: Record<string, unknown>): Record<string, WarpMcpServerConfig> | undefined {
  const value = args.mcp_servers;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, WarpMcpServerConfig>;
}

const dispatchTool: McpTool = {
  name: 'warp_dispatch_agent',
  requiredScope: WARP_DISPATCH_SCOPE,
  description:
    'Dispatch a Warp cloud agent using your sealed Warp Agent key. The run is stamped ' +
    '{your-handle}-jin for traceability and is attributed to your key\'s Warp service ' +
    'account, not to a human. Returns the run id, state, and session link. ' +
    'Requires an active warp:dispatch grant and a key sealed via warp_seal_key.',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'The task for the cloud agent to carry out',
      },
      title: {
        type: 'string',
        description: 'Optional human-readable run title',
      },
      skill_spec: {
        type: 'string',
        description:
          'Optional skill to use as the base prompt, as "owner/repo:skill-name" or ' +
          '"owner/repo:path/to/SKILL.md" (e.g. "ima-jin/imajin-ai:catalyst")',
      },
      environment_id: {
        type: 'string',
        description: 'Optional Warp cloud environment UID to run in',
      },
      model_id: {
        type: 'string',
        description: 'Optional model override (defaults to the team default)',
      },
      base_prompt: {
        type: 'string',
        description: 'Optional base prompt shaping the agent behaviour',
      },
      attach_imajin_mcp: {
        type: 'boolean',
        description:
          'Attach mcp.imajin.ai to the dispatched agent so it acts through Imajin ' +
          'primitives. Supply the agent\'s own bearer token via mcp_servers if needed.',
      },
      mcp_servers: {
        type: 'object',
        description:
          'Optional map of MCP server name to config, e.g. ' +
          '{ "imajin": { "url": "https://mcp.imajin.ai/mcp", "headers": { … } } }',
      },
    },
    required: ['prompt'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const prompt = str(args, 'prompt');
    if (prompt === undefined) throw new Error('prompt is required');

    const title = str(args, 'title');
    const skillSpec = str(args, 'skill_spec');
    const environmentId = str(args, 'environment_id');
    const modelId = str(args, 'model_id');
    const basePrompt = str(args, 'base_prompt');
    const mcpServers = mcpServersArg(args);

    const run = await dispatchAgentRun(ctx.did, {
      prompt,
      ...(title === undefined ? {} : { title }),
      ...(skillSpec === undefined ? {} : { skillSpec }),
      ...(environmentId === undefined ? {} : { environmentId }),
      ...(modelId === undefined ? {} : { modelId }),
      ...(basePrompt === undefined ? {} : { basePrompt }),
      ...(mcpServers === undefined ? {} : { mcpServers }),
      ...(typeof args.attach_imajin_mcp === 'boolean'
        ? { attachImajinMcp: args.attach_imajin_mcp }
        : {}),
    });

    return json(run);
  },
};

// ── Run status ────────────────────────────────────────────────────────────────

const getRunTool: McpTool = {
  name: 'warp_get_run',
  requiredScope: WARP_DISPATCH_SCOPE,
  description:
    'Read the lifecycle state and session link of a Warp cloud agent run you ' +
    'dispatched. Read with your own sealed key, so only your own runs are visible. ' +
    'Requires an active warp:dispatch grant and a key sealed via warp_seal_key.',
  inputSchema: {
    type: 'object',
    properties: {
      run_id: {
        type: 'string',
        description: 'The run id returned by warp_dispatch_agent',
      },
    },
    required: ['run_id'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const runId = str(args, 'run_id');
    if (runId === undefined) throw new Error('run_id is required');

    return json(await getAgentRun(ctx.did, runId));
  },
};

export const warpTools: McpTool[] = [sealKeyTool, dispatchTool, getRunTool];
