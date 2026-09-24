import type { McpTool } from '../types';
import { pingTool } from './ping';
import { mediaTools } from './media';
import { mediaWriteTools } from './media-write';
import { connectionTools } from './connections';
import { mediaShareTools } from './media-share';
import { mediaTranscribeTools } from './media-transcribe';
import { githubTools } from './github';
import { inferenceTools } from './inference';
import { discordTools } from './discord';
import { buzzTools } from './buzz';
import { messagesTools } from './messages';
import { warpTools } from './warp';
import { discoveryTools } from './discovery';
import { corpusTools } from './corpus';
import { loopsTools } from './loops';
import { cycleTools } from './cycle';
import { gmailTools } from './google-gmail';
import { calendarTools as googleCalendarTools } from './google-calendar';
import { driveTools as googleDriveTools } from './google-drive';
import { meetTools as googleMeetTools } from './google-meet';

/**
 * The MCP tool registry. To add a tool: create `./<tool>.ts` exporting an
 * McpTool and add it to this array. Nothing in the /mcp route or the JSON-RPC
 * dispatch changes — that is the RFC-32 federated-growth contract (#1166).
 *
 * Media READ tools (list/get/content/resolve) call the in-process media query
 * lib (src/lib/media/queries.ts) with ctx.did and gate per-asset reads through
 * canReadAsset (src/lib/media/read-access.ts). Media WRITE tools
 * (create_text/upload) call the in-process createAsset lib owner-pinned to
 * ctx.did and are gated by the 'media:write' scope per-tool (#1170).
 * Connections + share tools (#1195): connections_list (connections:read) and
 * media_grant_access (media:share) enable one-click share-by-name from Claude.
 * Discovery tools (#1636): read-only self-description of the node — API specs,
 * the scope vocabulary, and the caller's own connector status — gated by
 * 'discovery:read' so a dispatched agent can learn the system instead of
 * grepping source and guessing.
 * Loops tools (#2297): loops_list / loops_get, thin per-principal readers over
 * the kernel.loops registry projection (#2295) — the same query GET /api/loops
 * serves. Gated by 'loops:read'; every query is scoped to ctx.did.
 * Cycle tools (#2316): cycle_run / cycle_status, the one-statement trigger for
 * the sprint cycle — a thin MCP surface over the existing 'cycle' loopKind
 * (#2314, lib/loops/cycle.ts) and the DecisionCard emitter (#2315). Gated by
 * 'cycle:run'; every cycle is scoped to ctx.did. The phase engine itself is
 * stubbed behind a TODO seam (apps/kernel/src/lib/mcp/tools/cycle.ts) — out
 * of scope for #2316.
 * GitHub read depth (#1528): the connector's read verbs paginate the GitHub
 * Link header and report `has_more`, and cover pull requests, comments, and
 * search. All of them ride the existing 'github:read' scope, so the surface
 * grew without the scope vocabulary changing — `githubTools` is spread here
 * exactly as before.
 */
export const ALL_TOOLS: McpTool[] = [
  pingTool,
  ...mediaTools,
  ...mediaWriteTools,
  ...connectionTools,
  ...mediaShareTools,
  ...mediaTranscribeTools,
  ...githubTools,
  ...inferenceTools,
  ...discordTools,
  ...buzzTools,
  ...messagesTools,
  ...warpTools,
  ...discoveryTools,
  ...corpusTools,
  ...loopsTools,
  ...cycleTools,
  ...gmailTools,
  ...googleCalendarTools,
  ...googleDriveTools,
  ...googleMeetTools,
];

const TOOLS_BY_NAME = new Map<string, McpTool>(ALL_TOOLS.map((t) => [t.name, t]));

export function toolByName(name: string): McpTool | undefined {
  return TOOLS_BY_NAME.get(name);
}
