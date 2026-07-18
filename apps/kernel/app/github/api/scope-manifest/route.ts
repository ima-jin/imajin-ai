/**
 * GET + POST /github/api/scope-manifest (#1352)
 *
 * The missing publish path for the GitHub connector scope-manifest. Without
 * this route the `auth.channel_links` rows that gate every `github_*` tool
 * could never be created — `channel-links-surface` already knows how to project
 * them, but there was no way for an owner to trigger the projection.
 *
 * GET  — returns the current state: active scopes + manifest asset id.
 * POST — publishes or updates the scope-manifest, projecting the requested
 *        scopes into auth.channel_links via document.changed.
 *
 * Scope materialisation:
 *   github:read    → silent  → active immediately after POST.
 *   github:write   → on-consent → active only when a consent_grants row
 *                    exists for did:imajin:github-connector.
 *   github:org     → on-consent → same.
 *   github:actions → never → never materialises; omit for clarity.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import {
  publishGitHubScopeManifest,
  readActiveGitHubScopes,
  findGitHubManifestAsset,
  VALID_GITHUB_SCOPES,
} from '@/src/lib/github/scope-manifest';
import { configField, oauthVaultField, vaultField } from '@/src/lib/github/connector';
import { vaultFieldExists } from '@/src/lib/vault';

const log = createLogger('kernel');

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

// ── GET /github/api/scope-manifest ───────────────────────────────────────────

/**
 * Return the current state of the GitHub connector for the session owner:
 *   - `manifestAssetId`  — stable id of the scope-manifest asset (null = none yet).
 *   - `activeScopes`     — connector scopes currently active in channel_links.
 *   - `validScopes`      — all scopes accepted by POST.
 *   - `configSealed`     — whether the OAuth App config (clientId/Secret) is sealed.
 *   - `tokenSealed`      — whether an OAuth token OR PAT is sealed for this DID.
 *
 * Booleans only — sealed values are NEVER returned. (#1354 flag #3)
 */
export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);

  const auth = await requireAuth(request);
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status, headers: cors });
  }
  const ownerDid = resolveActingDid(auth.identity);

  const [manifestAsset, activeScopes, configSealed, oauthTokenSealed, patSealed] =
    await Promise.all([
      findGitHubManifestAsset(ownerDid),
      readActiveGitHubScopes(ownerDid),
      vaultFieldExists(configField(ownerDid)),
      vaultFieldExists(oauthVaultField(ownerDid)),
      vaultFieldExists(vaultField(ownerDid)),
    ]);

  return NextResponse.json(
    {
      manifestAssetId: manifestAsset?.id ?? null,
      activeScopes,
      validScopes: VALID_GITHUB_SCOPES,
      configSealed,
      // Token is satisfied by either the OAuth bundle or a PAT fallback.
      tokenSealed: oauthTokenSealed || patSealed,
    },
    { headers: cors },
  );
}

// ── POST /github/api/scope-manifest ──────────────────────────────────────────

/**
 * Publish or update the GitHub scope-manifest for the session owner.
 *
 * Body: `{ "scopes": ["github:read", "github:write"] }`
 *
 * `scopes` must be a (possibly empty) array of strings. Unknown scope names are
 * dropped silently. An empty array revokes all scopes. Only `github:read` and
 * `github:write` are likely to be immediately useful:
 *
 *   github:read   — materialises immediately (silent release).
 *   github:write  — materialises only when a consent_grants row exists for
 *                   did:imajin:github-connector (on-consent release).
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
  const validScopeSet = new Set<string>(VALID_GITHUB_SCOPES);
  const unknownScopes = requestedScopes.filter((s) => !validScopeSet.has(s));
  if (unknownScopes.length > 0) {
    return NextResponse.json(
      {
        error: `Unknown scope(s): ${unknownScopes.join(', ')}. Valid scopes: ${VALID_GITHUB_SCOPES.join(', ')}`,
      },
      { status: 400, headers: cors },
    );
  }

  let assetId: string;
  try {
    assetId = await publishGitHubScopeManifest(ownerDid, requestedScopes);
  } catch (err) {
    log.error({ err: String(err), ownerDid }, 'scope-manifest: publish failed');
    return NextResponse.json(
      { error: 'Failed to publish scope manifest', detail: String(err) },
      { status: 500, headers: cors },
    );
  }

  // Re-read the active scopes after projection so the caller can see what
  // actually materialised (github:write may remain absent until consent exists).
  const activeScopes = await readActiveGitHubScopes(ownerDid);

  return NextResponse.json(
    { published: true, assetId, activeScopes },
    { status: 200, headers: cors },
  );
}
