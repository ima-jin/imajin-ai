/**
 * MCP tool-surface types (#1166).
 *
 * One extensible surface: a tool is a self-contained descriptor + handler.
 * RFC-32 federated growth ADDS tools (new files registered in tools/index.ts);
 * the /mcp route and JSON-RPC dispatch never change.
 */

/** Per-call context derived from the verified OAuth access token. */
export interface McpToolContext {
  /** Resource-owner DID (access token `sub`). Use this for all per-DID data access. */
  did: string;
  /** Authorized party / client app DID (access token `azp`). */
  appDid: string;
  /** Granted scopes (access token `scope`). */
  scopes: Set<string>;
}

/** MCP tool result content. Text only for now; extend with image/resource later. */
export type McpContent = { type: 'text'; text: string };

export interface McpTool {
  name: string;
  description: string;
  /**
   * OAuth scope the caller must hold to invoke this tool, checked per-call in
   * handleMcpRpc BEFORE the handler runs. Omit for tools that need no scope
   * beyond the /mcp surface gate (e.g. ping). READ tools require 'media:read';
   * WRITE tools require 'media:write' — this is where read-grant ≠ write-grant
   * is enforced (#1170).
   */
  requiredScope?: string;
  /** JSON Schema for the tool arguments (advertised verbatim via tools/list). */
  inputSchema: Record<string, unknown>;
  handler(
    args: Record<string, unknown>,
    ctx: McpToolContext,
  ): Promise<McpContent[]> | McpContent[];
}
