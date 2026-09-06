/**
 * Shared auth preamble for kernel service-to-service routes gated on the
 * `ATTESTATION_INTERNAL_API_KEY` Bearer token (#1999 — extracted to fix a
 * SonarCloud duplicated-lines finding).
 *
 * `POST /api/attestations/internal`, `POST /api/attestations/chain-emit`,
 * and `POST /api/eligibility/evaluate` each started with the identical
 * four-line Bearer-token check. Factored out once rather than repeated a
 * third time.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

/**
 * Verify the request's `Authorization: Bearer <key>` header against
 * `ATTESTATION_INTERNAL_API_KEY`.
 *
 * Returns a ready-to-return 401 `NextResponse` (same shape every caller used
 * before this extraction: `{ error: 'Unauthorized' }`) when the server-side
 * key is unset or the caller's key doesn't match, or `null` when the caller
 * is authorized.
 *
 * Usage:
 *   const authError = requireInternalApiKey(request);
 *   if (authError) return authError;
 */
export function requireInternalApiKey(request: NextRequest): NextResponse | null {
  const authHeader = request.headers.get('authorization');
  const apiKey = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
  const expectedKey = process.env.ATTESTATION_INTERNAL_API_KEY;

  if (!expectedKey || apiKey !== expectedKey) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return null;
}
