import { NextResponse } from 'next/server';
import {
  MCP_ISSUER,
  OAUTH_AUTHORIZATION_ENDPOINT,
  OAUTH_TOKEN_ENDPOINT,
  OAUTH_REGISTRATION_ENDPOINT,
  MCP_SCOPES,
} from '@/src/lib/mcp/oauth-config';

/**
 * RFC 8414 — OAuth 2.0 Authorization Server Metadata.
 *
 * Decisions (#1166, revised by #1185):
 * - Dynamic Client Registration (RFC 7591) IS supported. Claude Desktop's
 *   connector flow REQUIRES it — with no `registration_endpoint` it fails with
 *   `oauth_error=registration_endpoint_missing`. We now advertise a REAL
 *   registration URL (never `null` — Claude's Zod validation throws on null;
 *   that gotcha only ever applied to the omitted/null case). DCR is
 *   abuse-mitigated: redirect-URI allowlist + scope cap + rate limit, and a
 *   registered client grants nothing until a real DID consents.
 * - Public client + PKCE S256 → token_endpoint_auth_methods_supported: ['none'].
 */
export function GET() {
  return NextResponse.json(
    {
      issuer: MCP_ISSUER,
      authorization_endpoint: OAUTH_AUTHORIZATION_ENDPOINT,
      token_endpoint: OAUTH_TOKEN_ENDPOINT,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: MCP_SCOPES,
      registration_endpoint: OAUTH_REGISTRATION_ENDPOINT, // RFC 7591 DCR (#1185)
      // revocation_endpoint: omitted for now — revocation is handled out-of-band
      //   via the existing session-based /api/auth/revoke + /auth/apps UI (the
      //   app.authorized attestation is the grant). Add an RFC 7009 endpoint here
      //   only once implemented; advertising an unimplemented URL breaks clients.
    },
    {
      headers: {
        'Cache-Control': 'public, max-age=3600',
        'Access-Control-Allow-Origin': '*',
      },
    },
  );
}
