/**
 * `GET /auth/api/verify/turn/:hash` — outsider-checkable turn verification
 * (#1978, epic #1758). **No authentication, by design**: an agent outside the
 * room can check whether a claim is backed by signed evidence without an
 * account (model: trustless-ai's free, no-auth `/verify-proof`).
 *
 * `:hash` is the turn's `outputHash` — the claim — as `sha256:<hex>` (a bare
 * 64-char hex is accepted too). Returns each matching turn's evidence chain
 * (tool names, input/output hashes, timestamps), the signer's DID and key id,
 * and per-row + overall signature validity; 404 for a hash nothing is
 * committed under (which is also what an altered claim yields); 400 for a
 * malformed hash; 429 once the per-IP budget is spent.
 *
 * The response is redaction-safe: hashes, tool names, timestamps and agent
 * DIDs only — never the principal, retained-output references, or any turn
 * payload. See `src/lib/turn-evidence/verify.ts`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getClientIP, rateLimit } from '@imajin/config';
import { normalizeHash } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { verifyTurnByHash } from '@/src/lib/turn-evidence/verify';
import { productionVerifyDeps } from '@/src/lib/turn-evidence/verify-deps';
import { VERIFY_RATE_LIMIT, VERIFY_RATE_WINDOW_MS } from '@/src/lib/turn-evidence/config';

export const dynamic = 'force-dynamic';

const log = createLogger('kernel:turn-evidence');

export function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

function decodeHashParam(raw: string): string | null {
  try {
    return normalizeHash(decodeURIComponent(raw));
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ hash: string }> }) {
  const cors = { ...corsHeaders(request), 'Cache-Control': 'no-store' };

  const limited = rateLimit(`turn-verify:${getClientIP(request)}`, VERIFY_RATE_LIMIT, VERIFY_RATE_WINDOW_MS);
  if (limited.limited) {
    return NextResponse.json(
      { error: 'Too many requests' },
      { status: 429, headers: { ...cors, 'Retry-After': String(limited.retryAfter) } },
    );
  }

  const { hash: rawHash } = await params;
  const hash = decodeHashParam(rawHash);
  if (hash === null) {
    return NextResponse.json(
      { error: 'hash must be "sha256:" followed by 64 hex characters' },
      { status: 400, headers: cors },
    );
  }

  try {
    const result = await verifyTurnByHash(hash, productionVerifyDeps);
    if (!result.found) {
      return NextResponse.json({ error: 'No evidence is committed under this hash' }, { status: 404, headers: cors });
    }
    return NextResponse.json({ hash: result.hash, matches: result.matches }, { headers: cors });
  } catch (err) {
    log.error({ err: String(err) }, 'turn verify failed');
    return NextResponse.json({ error: 'Failed to verify turn' }, { status: 500, headers: cors });
  }
}
