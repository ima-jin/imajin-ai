import type { z } from 'zod';
import type { McpTool } from '../types';
import { requireMcpGrant } from '../mcp-grant';
import { json } from './utils';

/** Dispatcher checks the token; each invocation also rechecks the live app grant. */
export function googleReaderTool<T extends z.ZodTypeAny>(options: {
  name: string;
  scope: string;
  description: string;
  inputSchema: Record<string, unknown>;
  schema: T;
  read: (ownerDid: string, input: z.output<T>) => Promise<unknown>;
}): McpTool {
  return {
    name: options.name,
    requiredScope: options.scope,
    description: options.description,
    inputSchema: options.inputSchema,
    async handler(args, ctx) {
      await requireMcpGrant(ctx.did, options.scope, ctx.appDid);
      return json(await options.read(ctx.did, options.schema.parse(args)));
    },
  };
}
