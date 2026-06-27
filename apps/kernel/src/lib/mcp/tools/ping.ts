import type { McpTool } from '../types';

/**
 * Trivial health-check tool. Confirms the whole path end-to-end: OAuth token
 * verification, audience binding, scope gate, JSON-RPC dispatch, and tool
 * execution — the first thing to validate against the DFOS harness (#1166)
 * before any media tools are added.
 */
export const pingTool: McpTool = {
  name: 'ping',
  description: 'Health check. Returns pong and server time; verifies auth + transport end-to-end.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler: (_args, ctx) => [
    { type: 'text', text: `pong — authenticated as ${ctx.did} at ${new Date().toISOString()}` },
  ],
};
