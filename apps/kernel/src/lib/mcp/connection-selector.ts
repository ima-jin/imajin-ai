import { listConnectorRegistrations } from '../kernel/connector-registry-store';
import { connectionSlot } from '../kernel/connection-slots';
import { withConnectorConnection } from '../kernel/connector-connection-context';
import type { McpTool } from './types';

/** Kept separate from tool execution so future organization selection has one seam. */
export async function resolveToolConnection(
  ownerDid: string,
  provider: string,
  selector?: unknown,
): Promise<string> {
  if (selector === undefined) return 'primary';
  if (typeof selector !== 'string' || !selector.trim()) {
    throw new Error('invalid_connection: connection must be a non-empty slot or label');
  }
  const rows = (await listConnectorRegistrations(ownerDid)).filter((row) => row.provider === provider);
  const exact = rows.find((row) => row.slot === selector);
  if (exact) return connectionSlot(exact.slot);
  // Legacy primary does not require a registry projection to have been written.
  if (selector === 'primary') return 'primary';
  const matches = rows.filter((row) => row.label === selector);
  if (matches.length === 1) return connectionSlot(matches[0].slot);
  if (matches.length > 1) {
    throw new Error(`ambiguous_connection: '${selector}' matches slots: ${matches.map((row) => row.slot).sort().join(', ')}`);
  }
  throw new Error(`unknown_connection: '${selector}' is not a ${provider} connection; available slots: ${rows.map((row) => row.slot).sort().join(', ') || 'primary'}`);
}

/** Bind the selected connection once; all nested action/token/grant calls inherit it. */
export function withToolConnection(tool: McpTool): McpTool {
  const provider = tool.name.startsWith('google_') ? 'google'
    : tool.name.startsWith('github_') ? 'github'
      : tool.name.startsWith('quickbooks_') ? 'quickbooks' : undefined;
  if (!provider) return tool;
  return {
    ...tool,
    inputSchema: {
      ...tool.inputSchema,
      properties: {
        ...(tool.inputSchema.properties as Record<string, unknown> | undefined),
        connection: { type: 'string', description: 'Connection slot or unique label (default primary).' },
      },
    },
    async handler(args, ctx) {
      const slot = await resolveToolConnection(ctx.did, provider, args.connection);
      const actionArgs = { ...args };
      delete actionArgs.connection;
      return withConnectorConnection(provider, ctx.did, slot, () => tool.handler(actionArgs, ctx));
    },
  };
}
