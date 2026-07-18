/**
 * GET + POST /discord/api/token (#1355)
 *
 * Pattern B credential ingestion for the Discord connector: seals a Discord
 * Bot Token in the vault WITHOUT requiring the token to be passed through a
 * chat client (avoiding the exposure that the MCP `discord_connect` tool has).
 *
 * POST — seals the bot token; accepts `{ token: string }`.
 * GET  — returns `{ tokenSealed: boolean }` (existence check, never the token).
 *
 * Security invariants:
 *   - The token value is never logged, never returned, never echoed.
 *   - Sealed value is accessible only via server-side `loadAndUnseal`.
 *   - Per-DID isolation: `discord-bot-token:${ownerDid}`.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { sealToken, vaultField } from '@/src/lib/discord/connector';
import { vaultFieldExists } from '@/src/lib/vault';

const log = createLogger('kernel');

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

// ── GET /discord/api/token ────────────────────────────────────────────────────

/** Returns `{ tokenSealed: boolean }` — whether a bot token is already sealed. */
export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);

  const auth = await requireAuth(request);
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status, headers: cors });
  }
  const ownerDid = resolveActingDid(auth.identity);

  const tokenSealed = await vaultFieldExists(vaultField(ownerDid));
  return NextResponse.json({ tokenSealed }, { headers: cors });
}

// ── POST /discord/api/token ───────────────────────────────────────────────────

/**
 * Seal a Discord Bot Token for the session owner.
 *
 * Body: `{ "token": "<Discord Bot Token>" }`
 *
 * The token must be non-empty. It is sealed immediately and never echoed back.
 * Re-posting replaces the previously sealed token (rotate semantics).
 */
export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  const auth = await requireAuth(request);
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status, headers: cors });
  }
  const ownerDid = resolveActingDid(auth.identity);

  let body: { token?: unknown };
  try {
    body = (await request.json()) as { token?: unknown };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: cors });
  }

  const token = typeof body.token === 'string' ? body.token.trim() : null;
  if (!token) {
    return NextResponse.json({ error: 'token must be a non-empty string' }, { status: 400, headers: cors });
  }

  try {
    await sealToken(ownerDid, token);
    log.info({ ownerDid }, 'Discord bot token sealed');
  } catch (err) {
    log.error({ err: String(err), ownerDid }, 'Discord bot token sealing failed');
    return NextResponse.json(
      { error: 'Failed to seal Discord bot token', detail: String(err) },
      { status: 500, headers: cors },
    );
  }

  return NextResponse.json({ sealed: true }, { status: 201, headers: cors });
}
