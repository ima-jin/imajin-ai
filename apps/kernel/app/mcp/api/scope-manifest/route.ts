/**
 * GET + POST /mcp/api/scope-manifest (#1394 child 1)
 *
 * The missing publish path for the native MCP connector scope-manifest. Without
 * this route the `auth.channel_links` rows that gate every MCP tool calling
 * `requireMcpGrant` could never be created — `channel-links-surface` already
 * knows how to project them, but there was no way for an owner to trigger the
 * projection.
 *
 * Unlike OAuth connectors (GitHub, QuickBooks), the MCP connector is native /
 * credential-free: enabling it is purely scope toggles — no connect flow, no
 * credential booleans in the response.
 *
 * GET  — returns the current state: active scopes, manifest asset id, valid scopes.
 * POST — publishes or updates the scope-manifest, projecting the requested scopes
 *        into auth.channel_links via document.changed.
 *
 * Scope materialisation:
 *   media:read       → silent  → active immediately after POST.
 *   connections:read → silent  → active immediately after POST.
 *   media:write      → on-consent → active only when a consent_grants row exists.
 *   media:share      → on-consent → same.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import {
  publishMcpScopeManifest,
  readActiveMcpScopes,
  findMcpManifestAsset,
  VALID_MCP_SCOPES,
} from '@/src/lib/mcp/scope-manifest';

const log = createLogger('kernel');

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

// ── GET /mcp/api/scope-manifest ───────────────────────────────────────────────

/**
 * Return the current state of the MCP connector for the session owner:
 *   - `manifestAssetId`  — stable id of the scope-manifest asset (null = none yet).
 *   - `activeScopes`     — connector scopes currently active in channel_links.
 *   - `validScopes`      — all scopes accepted by POST.
 *
 * No credential booleans — the MCP connector is native and requires no credential.
 */
export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);

  const auth = await requireAuth(request);
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status, headers: cors });
  }
  const ownerDid = resolveActingDid(auth.identity);

  const [manifestAsset, activeScopes] = await Promise.all([
    findMcpManifestAsset(ownerDid),
    readActiveMcpScopes(ownerDid),
  ]);

  return NextResponse.json(
    {
      manifestAssetId: manifestAsset?.id ?? null,
      activeScopes,
      validScopes: VALID_MCP_SCOPES,
    },
    { headers: cors },
  );
}

// ── POST /mcp/api/scope-manifest ──────────────────────────────────────────────

/**
 * Publish or update the MCP scope-manifest for the session owner.
 *
 * Body: `{ "scopes": ["media:read", "connections:read"] }`
 *
 * `scopes` must be a (possibly empty) array of strings. Unknown scope names are
 * rejected with 400 (fail-closed; no silent typo grants). An empty array revokes
 * all scopes.
 *
 *   media:read, connections:read — materialise immediately (silent release).
 *   media:write, media:share     — materialise only when a consent_grants row exists
 *                                  for did:imajin:mcp-connector (on-consent release).
 */
export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  const auth = await requireAuth(request);
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status, headers: cors });
  }
  const ownerDid = resolveActingDid(auth.identity);

  let body: { scopes?: unknown };
  try {
    body = (await request.json()) as { scopes?: unknown };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: cors });
  }

  if (!Array.isArray(body.scopes)) {
    return NextResponse.json(
      { error: 'scopes must be an array of scope strings' },
      { status: 400, headers: cors },
    );
  }

  const requestedScopes = body.scopes.filter((s): s is string => typeof s === 'string');

  // Reject any scope name not in the known set (fail-closed; no silent typo grants).
  const validScopeSet = new Set<string>(VALID_MCP_SCOPES);
  const unknownScopes = requestedScopes.filter((s) => !validScopeSet.has(s));
  if (unknownScopes.length > 0) {
    return NextResponse.json(
      {
        error: `Unknown scope(s): ${unknownScopes.join(', ')}. Valid scopes: ${VALID_MCP_SCOPES.join(', ')}`,
      },
      { status: 400, headers: cors },
    );
  }

  let assetId: string;
  try {
    assetId = await publishMcpScopeManifest(ownerDid, requestedScopes);
  } catch (err) {
    log.error({ err: String(err), ownerDid }, 'mcp scope-manifest: publish failed');
    return NextResponse.json(
      { error: 'Failed to publish scope manifest', detail: String(err) },
      { status: 500, headers: cors },
    );
  }

  // Re-read the active scopes after projection so the caller can see what
  // actually materialised (on-consent scopes may remain absent until consent exists).
  const activeScopes = await readActiveMcpScopes(ownerDid);

  return NextResponse.json(
    { published: true, assetId, activeScopes },
    { status: 200, headers: cors },
  );
}
