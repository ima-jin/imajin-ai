import type { McpTool } from '../types';
import { pingTool } from './ping';
import { mediaTools } from './media';
import { mediaWriteTools } from './media-write';
import { connectionTools } from './connections';
import { mediaShareTools } from './media-share';

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
 */
export const ALL_TOOLS: McpTool[] = [
  pingTool,
  ...mediaTools,
  ...mediaWriteTools,
  ...connectionTools,
  ...mediaShareTools,
];

const TOOLS_BY_NAME = new Map<string, McpTool>(ALL_TOOLS.map((t) => [t.name, t]));

export function toolByName(name: string): McpTool | undefined {
  return TOOLS_BY_NAME.get(name);
}
