import { rateLimit } from '@imajin/config';
import { ExternalMcpError } from './external-mcp-policy';

export const EXTERNAL_MCP_MEMBER_LIMIT = 20;
export const EXTERNAL_MCP_APP_LIMIT = 60;
export const EXTERNAL_MCP_WINDOW_MS = 60_000;
export const EXTERNAL_MCP_IN_FLIGHT_LIMIT = 4;

// Share the process-wide cap across Next route bundles; never store credentials here.
const processState = globalThis as typeof globalThis & {
  __imajinExternalMcpInFlight?: { count: number };
};
const inFlight = processState.__imajinExternalMcpInFlight ??= { count: 0 };

/** Synchronous admission before DB/unseal/audit; denials persist nothing. */
export function reserveExternalMcpCall(memberDid: string, appDid?: string): () => void {
  if (inFlight.count >= EXTERNAL_MCP_IN_FLIGHT_LIMIT) {
    throw new ExternalMcpError(503, 'External MCP capacity unavailable');
  }
  const member = rateLimit(`external-mcp:member:${memberDid}`, EXTERNAL_MCP_MEMBER_LIMIT, EXTERNAL_MCP_WINDOW_MS);
  if (member.limited || (appDid && rateLimit(
    `external-mcp:app:${appDid}`, EXTERNAL_MCP_APP_LIMIT, EXTERNAL_MCP_WINDOW_MS,
  ).limited)) {
    throw new ExternalMcpError(429, 'External MCP rate limit exceeded');
  }
  inFlight.count++;
  return () => { inFlight.count--; };
}
