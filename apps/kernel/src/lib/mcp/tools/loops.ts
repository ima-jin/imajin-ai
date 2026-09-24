/**
 * MCP loop-registry read tools (#2297).
 *
 * `loops_list` / `loops_get` are thin per-principal readers over the
 * `kernel.loops` projection the loops rail writes (#2295, epic #2288/#2290)
 * — the same read path `GET /api/loops` / `GET /api/loops/:loopId` serve
 * (`../../loops/query`). No new read model: these tools exist so an
 * orchestrating agent speaking MCP can ask "what's running for me right now,
 * what's blocked, what finished since T" without an HTTP round-trip through
 * its own dashboard session.
 *
 * Per-principal scoping is the default shape every MCP tool in this
 * directory follows (see tools/warp.ts, tools/corpus.ts): every query is
 * unconditionally scoped to `ctx.did` — the resource-owner DID resolved by
 * the /mcp route, whether the caller authenticated with an OAuth app+jwt
 * token or a delegate-grant static bearer (#2252). No tool argument can ever
 * name a different principal — there is no cross-DID surface here to grant
 * separately, so a call for another principal's loopId fails closed exactly
 * like `getLoopWithHistory` does for the HTTP route: reported as not-found,
 * indistinguishable from an unknown id.
 *
 * Gated by `loops:read` (packages/auth/src/scope-vocabulary.ts) under both
 * gates every other MCP-native (non-proxy) tool uses: the per-tool
 * `requiredScope` token check in server.ts, and the `requireMcpGrant`
 * scope-manifest grant check here — same shape as tools/connections.ts and
 * tools/media.ts.
 *
 * Template: modelled on tools/connections.ts + tools/warp.ts (in-process DB
 * read scoped to ctx.did, cursor pagination on the list tool).
 * RFC-32 federated-growth contract: only this file + tools/index.ts change.
 */
import type { McpTool } from '../types';
import { str, num, json } from './utils';
import { requireMcpGrant } from '../mcp-grant';
import { listLoopsPage, getLoopWithHistory, type ListLoopsPageFilters } from '../../loops/query';

const LOOPS_READ_SCOPE = 'loops:read';

/** Filters for {@link listLoopsPage}, read off the MCP tool arguments and pinned to the acting DID. */
function loopsListFilters(args: Record<string, unknown>, principal: string): ListLoopsPageFilters {
  const state = str(args, 'state');
  const kind = str(args, 'kind');
  const ancestor = str(args, 'ancestor');
  const since = str(args, 'since');
  const limit = num(args, 'limit');
  const cursor = str(args, 'cursor');

  return {
    principal,
    ...(state === undefined ? {} : { state }),
    ...(kind === undefined ? {} : { kind }),
    ...(ancestor === undefined ? {} : { ancestor }),
    ...(since === undefined ? {} : { since }),
    ...(limit === undefined ? {} : { limit }),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

const listLoopsTool: McpTool = {
  name: 'loops_list',
  requiredScope: LOOPS_READ_SCOPE,
  description:
    'List loops in your own loop registry — the runs, blockers, and recently finished items an ' +
    'orchestrating agent needs to check in on. Scoped to loops you own or are delegate for; there ' +
    'is no way to read another principal\'s loops through this tool. Returns ' +
    '{ loops, hasNextPage, nextCursor }; pass nextCursor back as cursor for the next page. Set ' +
    'ancestor to instead return that loop\'s full descendant lineage tree (ordered oldest-first, ' +
    'unpaginated) rather than the flat newest-active-first list. Requires an active loops:read ' +
    'grant on the Imajin MCP connector.',
  inputSchema: {
    type: 'object',
    properties: {
      state: {
        type: 'string',
        description: 'Optional loop lifecycle state filter, e.g. "queued", "running", "blocked", "finished".',
      },
      kind: {
        type: 'string',
        description: 'Optional loop kind filter, e.g. "warp.run".',
      },
      ancestor: {
        type: 'string',
        description:
          'Optional loop id — returns its full descendant lineage tree (this loop plus every loop ' +
          'transitively parented under it) instead of the flat list. cursor/limit are ignored when set.',
      },
      since: {
        type: 'string',
        description: 'Optional RFC-3339 lower bound on last-seen activity, e.g. "2026-09-01T00:00:00Z".',
      },
      limit: {
        type: 'number',
        description: 'Optional page size, 1–200 (defaults to 50). Out-of-range values are clamped.',
      },
      cursor: {
        type: 'string',
        description: 'Optional nextCursor from a previous loops_list page.',
      },
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    await requireMcpGrant(ctx.did, LOOPS_READ_SCOPE, ctx.appDid);
    const page = await listLoopsPage(loopsListFilters(args, ctx.did));
    return json(page);
  },
};

const getLoopTool: McpTool = {
  name: 'loops_get',
  requiredScope: LOOPS_READ_SCOPE,
  description:
    'Read one loop by id: its current lifecycle projection (state, summary, refs, timestamps) plus ' +
    'its full ordered event history. Only resolves loops you own or are delegate for — a loop id ' +
    'that exists but belongs to a different principal is reported the same way as an unknown id, so ' +
    'this never confirms existence to a caller who is not allowed to see it. Requires an active ' +
    'loops:read grant on the Imajin MCP connector.',
  inputSchema: {
    type: 'object',
    properties: {
      loop_id: {
        type: 'string',
        description: 'The loop id, e.g. from loops_list or a loop.* event payload.',
      },
    },
    required: ['loop_id'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    await requireMcpGrant(ctx.did, LOOPS_READ_SCOPE, ctx.appDid);
    const loopId = str(args, 'loop_id');
    if (loopId === undefined) throw new Error('loop_id is required');

    const result = await getLoopWithHistory(loopId, ctx.did);
    if (!result) {
      throw new Error('not_found: no loop with that id is visible to you');
    }
    return json(result);
  },
};

export const loopsTools: McpTool[] = [listLoopsTool, getLoopTool];
