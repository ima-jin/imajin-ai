/**
 * GET + POST /gemini/api/token (#1432)
 *
 * Pattern B credential ingestion for the Gemini connector: seals a Gemini
 * API key in the vault WITHOUT requiring the key to be passed through a
 * chat client.
 *
 * POST — seals the API key; accepts `{ token: string, baseUrl?: string, modelId?: string }`.
 *        `token` is the Gemini API key. `baseUrl` and `modelId` are optional overrides
 *        (defaults: GEMINI_BASE_URL env var and GEMINI_MODEL_ID env var).
 * GET  — returns `{ keySealed: boolean }` (existence check, never the key).
 *
 * Security invariants:
 *   - The key value is never logged, never returned, never echoed.
 *   - Sealed value is accessible only via server-side `loadAndUnseal`.
 *   - Per-DID isolation: `gemini-api-key:${ownerDid}`.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { sealApiKey, vaultField } from '@/src/lib/gemini/connector';
import { vaultFieldExists } from '@/src/lib/vault';

const log = createLogger('kernel');

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

// ── GET /gemini/api/token ─────────────────────────────────────────────────────

/** Returns `{ keySealed: boolean }` — whether an API key is already sealed. */
export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);

  const auth = await requireAuth(request);
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status, headers: cors });
  }
  const ownerDid = resolveActingDid(auth.identity);

  const keySealed = await vaultFieldExists(vaultField(ownerDid));
  return NextResponse.json({ keySealed }, { headers: cors });
}

// ── POST /gemini/api/token ────────────────────────────────────────────────────

/**
 * Seal a Gemini API key for the session owner.
 *
 * Body: `{ "token": "<Gemini API Key>", "baseUrl"?: "...", "modelId"?: "..." }`
 *
 * The key must be non-empty. It is sealed immediately and never echoed back.
 * Re-posting replaces the previously sealed key (rotate semantics).
 * `baseUrl` and `modelId` are optional — omit to use the env-var defaults.
 */
export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  const auth = await requireAuth(request);
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status, headers: cors });
  }
  const ownerDid = resolveActingDid(auth.identity);

  let body: { token?: unknown; baseUrl?: unknown; modelId?: unknown };
  try {
    body = (await request.json()) as { token?: unknown; baseUrl?: unknown; modelId?: unknown };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: cors });
  }

  const token = typeof body.token === 'string' ? body.token.trim() : null;
  if (!token) {
    return NextResponse.json({ error: 'token must be a non-empty string' }, { status: 400, headers: cors });
  }

  const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : undefined;
  const modelId = typeof body.modelId === 'string' ? body.modelId.trim() : undefined;

  try {
    await sealApiKey(ownerDid, token, baseUrl || undefined, modelId || undefined);
    log.info({ ownerDid }, 'Gemini API key sealed');
  } catch (err) {
    log.error({ err: String(err), ownerDid }, 'Gemini API key sealing failed');
    return NextResponse.json(
      { error: 'Failed to seal Gemini API key', detail: String(err) },
      { status: 500, headers: cors },
    );
  }

  return NextResponse.json({ sealed: true }, { status: 201, headers: cors });
}
