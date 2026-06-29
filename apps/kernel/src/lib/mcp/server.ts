/**
 * MCP JSON-RPC dispatch (#1166).
 *
 * Transport-agnostic: the /mcp route handles auth + HTTP; this module turns a
 * decoded JSON-RPC message + tool context into a response object (or null for
 * notifications). Tools come from the registry — adding tools never touches this.
 */
import { ALL_TOOLS, toolByName } from './tools';
import type { McpToolContext } from './types';

export const SERVER_INFO = { name: 'imajin-media-mcp', version: '0.1.0' };

// Protocol versions we can speak. Echo the client's if supported, else default.
const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2025-06-18', '2025-03-26']);
export const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

export function negotiateProtocol(requested: unknown): string {
  return typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.has(requested)
    ? requested
    : DEFAULT_PROTOCOL_VERSION;
}

interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: string | number | null;
  method?: unknown;
  params?: Record<string, unknown>;
}

function ok(id: JsonRpcMessage['id'], result: unknown) {
  return { jsonrpc: '2.0' as const, id: id ?? null, result };
}
function rpcError(id: JsonRpcMessage['id'], code: number, message: string) {
  return { jsonrpc: '2.0' as const, id: id ?? null, error: { code, message } };
}

/**
 * Handle one JSON-RPC message. Returns the response object, or `null` for
 * notifications (no `id`), which yield no HTTP body.
 */
export async function handleMcpRpc(
  msg: JsonRpcMessage,
  ctx: McpToolContext,
): Promise<object | null> {
  const isNotification = msg.id === undefined || msg.id === null;

  if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return isNotification ? null : rpcError(msg.id ?? null, -32600, 'Invalid Request');
  }

  switch (msg.method) {
    case 'initialize':
      return ok(msg.id, {
        protocolVersion: negotiateProtocol(msg.params?.protocolVersion),
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });

    // Client → server notifications: acknowledge with no body.
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;

    case 'ping':
      return ok(msg.id, {});

    case 'tools/list':
      return ok(msg.id, {
        tools: ALL_TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });

    case 'tools/call': {
      const name = msg.params?.name;
      const tool = typeof name === 'string' ? toolByName(name) : undefined;
      if (!tool) return rpcError(msg.id, -32602, `Unknown tool: ${String(name)}`);
      // Per-tool scope gate (#1170): the /mcp route only checks that SOME media
      // scope is present; the authoritative read-vs-write decision is here. A
      // read-only token cannot reach a write tool, and vice versa. Returned
      // in-band (isError) per MCP convention so the model sees why it was denied.
      if (tool.requiredScope && !ctx.scopes.has(tool.requiredScope)) {
        return ok(msg.id, {
          content: [{ type: 'text', text: `Error: insufficient_scope — '${tool.name}' requires the '${tool.requiredScope}' grant` }],
          isError: true,
        });
      }
      try {
        const args = (msg.params?.arguments as Record<string, unknown>) ?? {};
        const content = await tool.handler(args, ctx);
        return ok(msg.id, { content, isError: false });
      } catch (e) {
        // MCP convention: tool failures are returned in-band (isError), not as
        // protocol-level JSON-RPC errors, so the model can see what went wrong.
        return ok(msg.id, { content: [{ type: 'text', text: `Error: ${String(e)}` }], isError: true });
      }
    }

    default:
      return isNotification ? null : rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}
