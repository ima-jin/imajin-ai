/**
 * POST /auth/api/internal/grants/introspect — resolve delegated authority at
 * execution time (#1882 item 5).
 *
 * Internal-only endpoint (guarded by AUTH_INTERNAL_API_KEY via the
 * `x-internal-key` header, same convention as
 * `/auth/api/internal/verify-delegation`). Services call this per delegated
 * action rather than trusting a cached grant, so a revocation or expiry is
 * visible on the very next check. The response carries a short max-age so a
 * caller MAY cache a positive result briefly without reintroducing eventual
 * revocation.
 *
 * Fails closed: an unauthenticated caller, a malformed body, or a lookup
 * failure all resolve to `authorized: false` (never a silent allow) — only a
 * genuinely active, unexpired, audience-matching grant returns `true`.
 *
 * Body: { agentDid: string, capability: string, targetDid?: string }
 * Returns: { authorized: boolean, grantId?, delegatorDid?, agentDid?, expiresAt?, reason? }
 */
import { NextRequest, NextResponse } from 'next/server';
import { introspectGrant } from '@/src/lib/auth/grants';
import { GRANT_INTROSPECTION_CACHE_TTL } from '@imajin/auth';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

export async function POST(request: NextRequest) {
  const expectedKey = process.env.AUTH_INTERNAL_API_KEY;
  // An unset key must not degrade into "any caller matches undefined".
  if (!expectedKey || request.headers.get('x-internal-key') !== expectedKey) {
    return NextResponse.json({ authorized: false, error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ authorized: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const { agentDid, capability, targetDid } = (body ?? {}) as Record<string, unknown>;
  if (typeof agentDid !== 'string' || !agentDid || typeof capability !== 'string' || !capability) {
    return NextResponse.json({ authorized: false, error: 'agentDid and capability are required' }, { status: 400 });
  }

  try {
    const result = await introspectGrant({
      agentDid,
      capability,
      targetDid: typeof targetDid === 'string' ? targetDid : undefined,
    });
    return NextResponse.json(result, {
      headers: { 'Cache-Control': `private, max-age=${Math.floor(GRANT_INTROSPECTION_CACHE_TTL / 1000)}` },
    });
  } catch (err) {
    // A lookup failure is not an authorization. Deny, and say so loudly
    // enough that a broken database does not read as "this agent is denied
    // authority" versus "we could not check" — both fail closed, but only
    // the latter is a 500 the caller should alert on.
    log.error({ err: String(err) }, 'Grant introspection lookup failed');
    return NextResponse.json({ authorized: false, error: 'Lookup failed' }, { status: 500 });
  }
}
