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
 * ## Run surface (#1639)
 * Dispatch alone made a jin able to *start* work it could not then observe: the
 * only readable field was the lifecycle state, so a failed run was a dead end and
 * a running one could not be corrected. These tools close that loop over the
 * client functions the same issue added — list, read, transcript, conversation,
 * follow-up, cancel — and every one of them rides the caller's *own* sealed key,
 * so a DID can only ever reach runs its own credential created. That is why they
 * share the single `warp:dispatch` gate rather than splitting read from write:
 * there is no cross-DID surface here to grant separately.
 *
 * Template: modelled on tools/discord.ts.
 * RFC-32 federated-growth contract: only this file + tools/index.ts change.
 */
import type { McpTool } from '../types';
import { str, num, json } from './utils';
import { sealWarpAgentKey, WARP_DISPATCH_SCOPE } from '@/src/lib/warp/connector';
import {
  cancelAgentRun,
  dispatchAgentRun,
  getAgentRun,
  getAgentRunConversation,
  getAgentRunTranscript,
  listAgentRuns,
  sendFollowup,
  type ListAgentRunsInput,
  type WarpFollowupMode,
  type WarpMcpServerConfig,
} from '@/src/lib/warp/dispatch';

/**
 * The `run_id` argument, or a throw naming the field that was missing.
 *
 * Every per-run tool validates through here so a blank id fails before the
 * credential is unwrapped, and every one of them fails with the same message.
 */
function requireRunIdArg(args: Record<string, unknown>): string {
  const runId = str(args, 'run_id');
  if (runId === undefined) throw new Error('run_id is required');
  return runId;
}

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
      conversation_id: {
        type: 'string',
        description:
          'Optional conversation id to continue (#1939) — Warp resumes from where a prior ' +
          'run under this conversation left off',
      },
      parent_run_id: {
        type: 'string',
        description:
          'Optional parent run id for an orchestration hierarchy (#1939). The parent run ' +
          'must exist and be visible to your own sealed key.',
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
    const conversationId = str(args, 'conversation_id');
    const parentRunId = str(args, 'parent_run_id');
    const modelId = str(args, 'model_id');
    const basePrompt = str(args, 'base_prompt');
    const mcpServers = mcpServersArg(args);

    const run = await dispatchAgentRun(ctx.did, {
      prompt,
      ...(title === undefined ? {} : { title }),
      ...(skillSpec === undefined ? {} : { skillSpec }),
      ...(environmentId === undefined ? {} : { environmentId }),
      ...(conversationId === undefined ? {} : { conversationId }),
      ...(parentRunId === undefined ? {} : { parentRunId }),
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
    'Read the full detail of a Warp cloud agent run you dispatched: lifecycle state ' +
    'and status message (with Warp\'s error code when it failed), session link, ' +
    'created/started/updated timestamps and run_time, cost (inference, compute, ' +
    'platform), creator and executor, resolved model/environment/skill, and the ' +
    'artifacts it produced — including the url and branch of any pull request. ' +
    'Read with your own sealed key, so only your own runs are visible. ' +
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
    return json(await getAgentRun(ctx.did, requireRunIdArg(args)));
  },
};

// ── Run history ───────────────────────────────────────────────────────────────

/**
 * Read the `state` filter, which is one state or several.
 *
 * Warp matches any of the given states, so both shapes map onto the client's
 * `states` array. Non-string entries are dropped rather than failing the list: a
 * malformed filter should narrow the read, never deny it.
 */
function statesArg(args: Record<string, unknown>): string[] | undefined {
  const value = args.state;
  const candidates = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];

  const states: string[] = [];
  for (const entry of candidates) {
    if (typeof entry !== 'string') continue;
    const state = entry.trim();
    if (state.length > 0) states.push(state);
  }

  return states.length === 0 ? undefined : states;
}

/** Filters for {@link listAgentRuns}, read off the snake_case MCP arguments. */
function listFilters(args: Record<string, unknown>): ListAgentRunsInput {
  const name = str(args, 'name');
  const states = statesArg(args);
  const environmentId = str(args, 'environment_id');
  const createdAfter = str(args, 'created_after');
  const cursor = str(args, 'cursor');
  const ancestorRunId = str(args, 'ancestor_run_id');
  const limit = num(args, 'limit');

  return {
    ...(name === undefined ? {} : { name }),
    ...(states === undefined ? {} : { states }),
    ...(environmentId === undefined ? {} : { environmentId }),
    ...(createdAfter === undefined ? {} : { createdAfter }),
    ...(cursor === undefined ? {} : { cursor }),
    ...(ancestorRunId === undefined ? {} : { ancestorRunId }),
    ...(limit === undefined ? {} : { limit }),
  };
}

const listRunsTool: McpTool = {
  name: 'warp_list_runs',
  requiredScope: WARP_DISPATCH_SCOPE,
  description:
    'List the Warp cloud agent runs your sealed key can see, newest-updated first. ' +
    'Filter by the {your-handle}-jin name a dispatch was stamped with, by state, by ' +
    'environment, or by creation time — this is how you read your own run history ' +
    'and what it cost. Returns { runs, hasNextPage, nextCursor }; pass nextCursor ' +
    'back as cursor for the next page. Only your own runs are visible. ' +
    'Requires an active warp:dispatch grant and a key sealed via warp_seal_key.',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description:
          'Optional Warp config name to match, i.e. the {your-handle}-jin tag a ' +
          'dispatch was stamped with (e.g. "veteze-jin")',
      },
      state: {
        description:
          'Optional run state, or a list of states to match any of: QUEUED, ' +
          'INPROGRESS, SUCCEEDED, FAILED, CANCELLED, BLOCKED',
        anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
      },
      environment_id: {
        type: 'string',
        description: 'Optional Warp cloud environment UID the runs landed in',
      },
      created_after: {
        type: 'string',
        description: 'Optional RFC-3339 lower bound on creation time, e.g. "2026-08-01T00:00:00Z"',
      },
      limit: {
        type: 'number',
        description: 'Optional page size, 1–500 (Warp defaults to 20). Out-of-range values are clamped.',
      },
      cursor: {
        type: 'string',
        description: 'Optional nextCursor from a previous warp_list_runs page',
      },
      ancestor_run_id: {
        type: 'string',
        description:
          'Optional run id (#1939) — lists every run spawned, directly or transitively, ' +
          "from this ancestor's parentRunId lineage",
      },
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    return json(await listAgentRuns(ctx.did, listFilters(args)));
  },
};

// ── Run output ────────────────────────────────────────────────────────────────

const getTranscriptTool: McpTool = {
  name: 'warp_get_transcript',
  requiredScope: WARP_DISPATCH_SCOPE,
  description:
    'Read the raw transcript of a Warp cloud agent run you dispatched. This is the ' +
    'self-diagnosis path: when a run fails, the transcript is the only place that ' +
    'says why. Returns { runId, content, contentType, truncated }; content is capped ' +
    'and truncated is true when it was cut. Read with your own sealed key, so only ' +
    'your own runs are visible. Requires an active warp:dispatch grant and a key ' +
    'sealed via warp_seal_key.',
  inputSchema: {
    type: 'object',
    properties: {
      run_id: {
        type: 'string',
        description: 'The run id returned by warp_dispatch_agent',
      },
      max_chars: {
        type: 'number',
        description:
          'Optional cap on the transcript text returned, in characters. Lower it when ' +
          'you only need the head of a long transcript.',
      },
    },
    required: ['run_id'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const runId = requireRunIdArg(args);
    const maxChars = num(args, 'max_chars');

    return json(
      await getAgentRunTranscript(
        ctx.did,
        runId,
        maxChars === undefined ? {} : { maxChars },
      ),
    );
  },
};

const getConversationTool: McpTool = {
  name: 'warp_get_conversation',
  requiredScope: WARP_DISPATCH_SCOPE,
  description:
    'Read the normalized conversation of a Warp cloud agent run you dispatched: the ' +
    'step tree with each message\'s role and content blocks (text, actions, action ' +
    'results, events). Prefer this over warp_get_transcript when you want to reason ' +
    'about what the agent did rather than read raw text. Returns ' +
    '{ runId, conversationId, steps }. Read with your own sealed key, so only your ' +
    'own runs are visible. Requires an active warp:dispatch grant and a key sealed ' +
    'via warp_seal_key.',
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
    return json(await getAgentRunConversation(ctx.did, requireRunIdArg(args)));
  },
};

// ── Run control ───────────────────────────────────────────────────────────────

const sendFollowupTool: McpTool = {
  name: 'warp_send_followup',
  requiredScope: WARP_DISPATCH_SCOPE,
  description:
    'Send a message to a Warp cloud agent run that is already going — mid-run course ' +
    'correction instead of cancel-and-redispatch. Returns { runId, accepted: true }: ' +
    'acceptance is not application, so observe the effect with warp_get_run. ' +
    'Delivered with your own sealed key, so you can only talk to your own runs. ' +
    'A run that has already ended is refused unless resume is set (#1939) — pass ' +
    'resume: true to continue it via Warp\'s cloud-to-cloud handoff. ' +
    'Requires an active warp:dispatch grant and a key sealed via warp_seal_key.',
  inputSchema: {
    type: 'object',
    properties: {
      run_id: {
        type: 'string',
        description: 'The run id returned by warp_dispatch_agent',
      },
      message: {
        type: 'string',
        description: 'The message to deliver to the running agent',
      },
      mode: {
        type: 'string',
        enum: ['normal', 'plan', 'orchestrate'],
        description:
          'Optional query mode for the message (defaults to normal). Warp does not ' +
          'infer this from the message text, so state it when you want plan or ' +
          'orchestrate behaviour.',
      },
      resume: {
        type: 'boolean',
        description:
          'Continue a run that has already ended, via cloud-to-cloud handoff (#1939). ' +
          'Defaults to false — a terminal run is refused unless this is explicitly true.',
      },
    },
    required: ['run_id', 'message'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const runId = requireRunIdArg(args);

    const message = str(args, 'message');
    if (message === undefined) throw new Error('message is required');

    // Cast rather than validated here: the closed set lives in the client, so the
    // HTTP and MCP callers reject an unknown mode with the same error.
    const mode = str(args, 'mode') as WarpFollowupMode | undefined;
    const resume = typeof args.resume === 'boolean' ? args.resume : undefined;

    return json(
      await sendFollowup(ctx.did, runId, {
        message,
        ...(mode === undefined ? {} : { mode }),
        ...(resume === undefined ? {} : { resume }),
      }),
    );
  },
};

const cancelRunTool: McpTool = {
  name: 'warp_cancel_run',
  requiredScope: WARP_DISPATCH_SCOPE,
  description:
    'Cancel a queued or in-progress Warp cloud agent run you dispatched, so a run ' +
    'that is going the wrong way stops costing money. Returns ' +
    '{ runId, cancelled: true }. A run that is already finished, still pending, or ' +
    'of a type Warp cannot cancel is reported as an error rather than silently ' +
    'succeeding. Cancelled with your own sealed key, so you can only cancel your own ' +
    'runs. Requires an active warp:dispatch grant and a key sealed via warp_seal_key.',
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
    return json(await cancelAgentRun(ctx.did, requireRunIdArg(args)));
  },
};

export const warpTools: McpTool[] = [
  sealKeyTool,
  dispatchTool,
  getRunTool,
  listRunsTool,
  getTranscriptTool,
  getConversationTool,
  sendFollowupTool,
  cancelRunTool,
];
