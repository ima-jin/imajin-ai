/**
 * GET + POST /discord/api/scope-manifest (#1355)
 *
 * Mirrors GET + POST /github/api/scope-manifest for the Discord connector
 * (Pattern B — token-paste). Both scopes (discord:post, discord:read) are
 * on-consent; the POST handler writes the consent_grants row before firing
 * document.changed so the broker release gate passes.
 *
 * GET  — returns current state: active scopes, manifest asset id, token status.
 * POST — publishes/updates the scope-manifest, projecting scopes into
 *         auth.channel_links via document.changed.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import {
  publishDiscordScopeManifest,
  readActiveDiscordScopes,
  findDiscordManifestAsset,
  discordTokenSealed,
  VALID_DISCORD_SCOPES,
} from '@/src/lib/discord/scope-manifest';

const log = createLogger('kernel');

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

// ── GET /discord/api/scope-manifest ──────────────────────────────────────────

/**
 * Return current Discord connector state for the session owner:
 *   - `manifestAssetId` — stable id of the scope-manifest asset (null = none yet).
 *   - `activeScopes`    — scopes currently active in channel_links.
 *   - `validScopes`     — all scopes accepted by POST.
 *   - `tokenSealed`     — whether a Discord Bot Token is sealed for this DID.
 *
 * Token value is never returned — booleans only.
 */
export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);

  const auth = await requireAuth(request);
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status, headers: cors });
  }
  const ownerDid = resolveActingDid(auth.identity);

  const [manifestAsset, activeScopes, tokenSealedResult] = await Promise.all([
    findDiscordManifestAsset(ownerDid),
    readActiveDiscordScopes(ownerDid),
    discordTokenSealed(ownerDid),
  ]);

  return NextResponse.json(
    {
      manifestAssetId: manifestAsset?.id ?? null,
      activeScopes,
      validScopes: VALID_DISCORD_SCOPES,
      tokenSealed: tokenSealedResult,
    },
    { headers: cors },
  );
}

// ── POST /discord/api/scope-manifest ─────────────────────────────────────────

/**
 * Publish or update the Discord scope-manifest for the session owner.
 *
 * Body: `{ "scopes": ["discord:post", "discord:read"] }`
 *
 * Both discord:post and discord:read are on-consent. This handler writes the
 * consent_grants rows needed for the broker release gate before firing
 * document.changed, so the scopes materialise immediately after POST.
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

  const validScopeSet = new Set<string>(VALID_DISCORD_SCOPES);
  const unknownScopes = requestedScopes.filter((s) => !validScopeSet.has(s));
  if (unknownScopes.length > 0) {
    return NextResponse.json(
      { error: `Unknown scope(s): ${unknownScopes.join(', ')}. Valid: ${VALID_DISCORD_SCOPES.join(', ')}` },
      { status: 400, headers: cors },
    );
  }

  let assetId: string;
  try {
    assetId = await publishDiscordScopeManifest(ownerDid, requestedScopes);
  } catch (err) {
    log.error({ err: String(err), ownerDid }, 'discord scope-manifest: publish failed');
    return NextResponse.json(
      { error: 'Failed to publish Discord scope manifest', detail: String(err) },
      { status: 500, headers: cors },
    );
  }

  const activeScopes = await readActiveDiscordScopes(ownerDid);
  return NextResponse.json({ published: true, assetId, activeScopes }, { status: 200, headers: cors });
}
