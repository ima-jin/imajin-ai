import type { McpTool, McpContent } from '../types';
import { listConnections } from '../../connections/list';
import { requireMcpGrant } from '../mcp-grant';

/**
 * Connections tool for the MCP connector (#1195).
 *
 * connections_list returns the caller's trust-graph connections enriched with
 * handle, name, and nickname — so Claude can resolve "Eric" → his DID for
 * one-click sharing without the user ever copy-pasting a raw did:imajin:… string.
 *
 * Gated by connections:read. Returns only the caller's own connections (ctx.did).
 */

function json(value: unknown): McpContent[] {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
}

const connectionsListTool: McpTool = {
  name: 'connections_list',
  requiredScope: 'connections:read',
  description:
    'List your trust-graph connections (people you are connected with). Returns did, handle, name, and nickname for each connection so you can resolve a person\'s name to their DID for sharing. Only returns your own connections.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  async handler(_args, ctx) {
    await requireMcpGrant(ctx.did, 'connections:read');
    const conns = await listConnections(ctx.did);
    return json({
      count: conns.length,
      connections: conns.map(({ did, handle, name, nickname }) => ({ did, handle, name, nickname })),
    });
  },
};

export const connectionTools: McpTool[] = [connectionsListTool];
