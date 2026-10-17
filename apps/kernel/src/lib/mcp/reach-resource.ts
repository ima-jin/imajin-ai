import { nodeUrl } from '@/src/lib/http/node-url';

export const REACH_SCOPE = 'agent:reach';
export const REACH_GATED_TOOLS = new Set(['reach_ask', 'reach_send', 'reach_status']);

export function reachResourceUrls(handle: string) {
  const path = `/reach/${encodeURIComponent(handle)}`;
  const origin = nodeUrl();
  return {
    resource: `${origin}${path}/mcp`,
    metadata: `${origin}/.well-known/oauth-protected-resource${path}/mcp`,
    knock: `${origin}${path}/knock`,
  };
}
