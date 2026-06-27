import type { McpTool } from '../types';
import { pingTool } from './ping';

/**
 * The MCP tool registry. To add a tool: create `./<tool>.ts` exporting an
 * McpTool and add it to this array. Nothing in the /mcp route or the JSON-RPC
 * dispatch changes — that is the RFC-32 federated-growth contract (#1166).
 *
 * Media READ tools (list/get/content/resolve) land here in a later step, each
 * calling the in-process media lib (src/lib/media/routes/*) with ctx.did.
 */
export const ALL_TOOLS: McpTool[] = [
  pingTool,
];

const TOOLS_BY_NAME = new Map<string, McpTool>(ALL_TOOLS.map((t) => [t.name, t]));

export function toolByName(name: string): McpTool | undefined {
  return TOOLS_BY_NAME.get(name);
}
