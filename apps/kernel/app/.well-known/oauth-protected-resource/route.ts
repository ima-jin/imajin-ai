import { NextResponse } from 'next/server';
import { getMcpIssuer, getMcpResource, MCP_SCOPES } from '@/src/lib/mcp/oauth-config';

/**
 * RFC 9728 — OAuth 2.0 Protected Resource Metadata.
 *
 * Claude Desktop hits /mcp unauthenticated, receives 401 +
 * `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource"`,
 * fetches THIS doc, and learns which authorization server to use.
 */
export function GET() {
  return NextResponse.json(
    {
      resource: getMcpResource(),
      authorization_servers: [getMcpIssuer()],
      scopes_supported: MCP_SCOPES,
      bearer_methods_supported: ['header'],
    },
    {
      headers: {
        'Cache-Control': 'public, max-age=3600',
        'Access-Control-Allow-Origin': '*',
      },
    },
  );
}
