import { z } from 'zod';

export const EXTERNAL_MCP_SCOPE = 'external-mcp:read';
export const POSTMAN_PROVIDER = 'external-mcp-postman';
// A reviewed target, never a caller-controlled URL, header, or redirect.
export const POSTMAN_MCP_URL = 'https://mcp.postman.com/mcp';
export const memberDidSchema = z.string().max(256).regex(/^did:[a-z0-9]+:[a-zA-Z0-9._:-]+$/);
const identifier = z.string().min(1).max(256);
const collection = { collectionId: identifier };
const pagination = { limit: z.number().int().min(1).max(99).optional(), offset: z.number().int().min(0).optional() };

// Exact names and argument shapes, not readOnlyHint or a get* prefix.
const READ_TOOLS = {
  getWorkspaces: z.object({ type: identifier.optional(), createdBy: identifier.optional() }).strict(),
  getWorkspace: z.object({ workspaceId: identifier }).strict(),
  getCollections: z.object({ workspace: identifier, name: identifier.optional(), ...pagination }).strict(),
  getCollection: z.object({ ...collection, model: z.enum(['minimal', 'full']).optional() }).strict(),
  getCollectionRequest: z.object({
    ...collection, requestId: identifier, ids: z.boolean().optional(),
    uid: z.boolean().optional(), populate: z.boolean().optional(),
  }).strict(),
  getEnvironments: z.object({ workspace: identifier.optional() }).strict(),
  getEnvironment: z.object({ environmentId: identifier }).strict(),
} as const;

export class ExternalMcpError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
export function allowedPostmanTool(name: string): name is keyof typeof READ_TOOLS {
  return Object.hasOwn(READ_TOOLS, name);
}
export const connectInput = z.object({
  secret: z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/),
  orgContextDid: memberDidSchema.optional(),
}).strict();
const rpcInput = z.object({
  jsonrpc: z.literal('2.0'), id: z.union([z.string().max(128), z.number().int()]),
  method: z.enum(['tools/list', 'tools/call']),
  memberDid: memberDidSchema.optional(),
  params: z.object({
    name: z.string().max(128).optional(),
    arguments: z.record(z.string(), z.unknown()).optional(),
    cursor: z.string().max(1024).optional(),
  }).strict().optional(),
}).strict();

/** Strip the kernel-only member selector; never relay protocol extensions. */
export function parseExternalMcpCall(raw: unknown) {
  const parsed = rpcInput.safeParse(raw);
  if (!parsed.success) throw new ExternalMcpError(400, 'Invalid external MCP request');
  const input = parsed.data;
  if (input.method === 'tools/list') {
    if (input.params?.name || input.params?.arguments) throw new ExternalMcpError(400, 'Invalid tool list parameters');
    return input;
  }
  const name = input.params?.name;
  if (!name || !allowedPostmanTool(name)) {
    throw new ExternalMcpError(403, 'Tool refused: only allowlisted read-only tools are permitted; writes and live requests are disabled');
  }
  if (input.params?.cursor || !READ_TOOLS[name].safeParse(input.params?.arguments ?? {}).success) {
    throw new ExternalMcpError(400, 'Invalid read-only tool arguments');
  }
  return input;
}
export type ExternalMcpCall = ReturnType<typeof parseExternalMcpCall>;
