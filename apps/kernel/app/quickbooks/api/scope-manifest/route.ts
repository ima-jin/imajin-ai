/**
 * GET + POST /quickbooks/api/scope-manifest (#1356)
 *
 * Mirrors the GitHub and Discord scope-manifest routes for the QuickBooks
 * connector (Pattern A — OAuth2). quickbooks:read is silent and materialises
 * immediately; quickbooks:write is on-consent (consent_grants written
 * before document.changed fires).
 *
 * GET  — current state: active scopes, manifest asset id, config + token sealed.
 * POST — publish/update the scope-manifest → projects into auth.channel_links.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import {
  publishQuickBooksScopeManifest,
  readActiveQuickBooksScopes,
  findQuickBooksManifestAsset,
  quickbooksConfigSealed,
  quickbooksTokenSealed,
  VALID_QUICKBOOKS_SCOPES,
} from '@/src/lib/quickbooks/scope-manifest';

const log = createLogger('kernel');

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

// ── GET /quickbooks/api/scope-manifest ────────────────────────────────────────

/**
 * Returns current QuickBooks connector state for the session owner:
 *   - manifestAssetId — stable id of the scope-manifest asset (null = none yet).
 *   - activeScopes    — scopes currently active in channel_links.
 *   - validScopes     — scopes accepted by POST.
 *   - configSealed    — whether the OAuth App config is sealed.
 *   - tokenSealed     — whether a QuickBooks OAuth token bundle is sealed.
 *
 * Booleans only — sealed values are never returned.
 */
export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);

  const auth = await requireAuth(request);
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status, headers: cors });
  }
  const ownerDid = resolveActingDid(auth.identity);

  const [manifestAsset, activeScopes, configSealedResult, tokenSealedResult] = await Promise.all([
    findQuickBooksManifestAsset(ownerDid),
    readActiveQuickBooksScopes(ownerDid),
    quickbooksConfigSealed(ownerDid),
    quickbooksTokenSealed(ownerDid),
  ]);

  return NextResponse.json(
    {
      manifestAssetId: manifestAsset?.id ?? null,
      activeScopes,
      validScopes: VALID_QUICKBOOKS_SCOPES,
      configSealed: configSealedResult,
      tokenSealed: tokenSealedResult,
    },
    { headers: cors },
  );
}

// ── POST /quickbooks/api/scope-manifest ───────────────────────────────────────

/**
 * Publish or update the QuickBooks scope-manifest for the session owner.
 *
 * Body: `{ "scopes": ["quickbooks:read", "quickbooks:write"] }`
 *
 * quickbooks:read (silent) materialises immediately.
 * quickbooks:write (on-consent) materialises once a consent_grants row exists
 * for did:imajin:quickbooks-connector — this handler writes that row.
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
  const validScopeSet = new Set<string>(VALID_QUICKBOOKS_SCOPES);
  const unknownScopes = requestedScopes.filter((s) => !validScopeSet.has(s));
  if (unknownScopes.length > 0) {
    return NextResponse.json(
      { error: `Unknown scope(s): ${unknownScopes.join(', ')}. Valid: ${VALID_QUICKBOOKS_SCOPES.join(', ')}` },
      { status: 400, headers: cors },
    );
  }

  let assetId: string;
  try {
    assetId = await publishQuickBooksScopeManifest(ownerDid, requestedScopes);
  } catch (err) {
    log.error({ err: String(err), ownerDid }, 'quickbooks scope-manifest: publish failed');
    return NextResponse.json(
      { error: 'Failed to publish QuickBooks scope manifest', detail: String(err) },
      { status: 500, headers: cors },
    );
  }

  const activeScopes = await readActiveQuickBooksScopes(ownerDid);
  return NextResponse.json({ published: true, assetId, activeScopes }, { status: 200, headers: cors });
}
