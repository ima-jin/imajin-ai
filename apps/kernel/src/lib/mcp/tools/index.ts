import type { McpTool } from '../types';
import { pingTool } from './ping';
import { mediaTools } from './media';

/**
 * The MCP tool registry. To add a tool: create `./<tool>.ts` exporting an
 * McpTool and add it to this array. Nothing in the /mcp route or the JSON-RPC
 * dispatch changes — that is the RFC-32 federated-growth contract (#1166).
 *
 * Media READ tools (list/get/content/resolve) call the in-process media query
 * lib (src/lib/media/queries.ts) with ctx.did and gate per-asset reads through
 * canReadAsset (src/lib/media/read-access.ts).
 */
export const ALL_TOOLS: McpTool[] = [
  pingTool,
  ...mediaTools,
];

const TOOLS_BY_NAME = new Map<string, McpTool>(ALL_TOOLS.map((t) => [t.name, t]));

export function toolByName(name: string): McpTool | undefined {
  return TOOLS_BY_NAME.get(name);
}
