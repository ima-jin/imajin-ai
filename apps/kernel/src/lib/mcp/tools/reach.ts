import type { McpTool } from '../types';
import { reachStatus } from '../../auth/reach-status';
import { str, json } from './utils';

/**
 * Read only the authenticated token subject's own receipt. No additional
 * principal-issued grant is needed to read a reply already addressed to it.
 * Per-principal C6 and A2A C7 adapters can reuse reachStatus directly.
 */
export const reachStatusTool: McpTool = {
  name: 'reach_status',
  description: 'Read delivery state and the principal-signed reply for a reach you sent. A reachId does not authorize another caller to read it.',
  inputSchema: {
    type: 'object',
    properties: {
      principalDid: { type: 'string', description: 'The recipient principal DID.' },
      reachId: { type: 'string', description: 'The reachId returned by reach_send.' },
    },
    required: ['principalDid', 'reachId'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const principalDid = str(args, 'principalDid');
    const reachId = str(args, 'reachId');
    if (!principalDid || !reachId) throw new Error('principalDid and reachId are required');
    const result = await reachStatus({ principalDid, reachId, requesterDid: ctx.did });
    if (!result) throw new Error('Reach not found');
    return json(result);
  },
};
