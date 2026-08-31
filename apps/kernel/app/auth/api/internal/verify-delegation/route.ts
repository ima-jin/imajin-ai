/**
 * POST /auth/api/internal/verify-delegation
 *
 * Internal-only endpoint (guarded by AUTH_INTERNAL_API_KEY) that answers a
 * single question: may `agentDid` act for `principalDid`?
 *
 * #1887 migrated this from a membership-only lookup to the grants-first
 * dual-read resolution in `@/src/lib/auth/agent-authority` — grants first,
 * falling back to the pre-#1887 role='agent' `identity_members` check when
 * no active grant exists (logged, so fallback volume is observable). See
 * that module for the flag that controls/rolls back this behavior.
 *
 * ws-server.js calls this to authorize `register_also` (#1653). ws-server is
 * plain CJS running outside Next, so it reaches the database through this route
 * rather than importing drizzle directly — the same shape as the session and
 * ws-token checks it already makes. packages/auth's `requireAuth` also calls
 * this endpoint to resolve the X-Acting-For bootstrap (#1887).
 *
 * Fails closed: anything short of a positive match answers `allowed: false`.
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveAgentAuthority } from '@/src/lib/auth/agent-authority';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

export async function POST(request: NextRequest) {
  const expectedKey = process.env.AUTH_INTERNAL_API_KEY;
  // An unset key must not degrade into "any caller matches undefined" — refuse
  // outright rather than leaving the endpoint open.
  if (!expectedKey || request.headers.get('x-internal-key') !== expectedKey) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { agentDid, principalDid } = (body ?? {}) as Record<string, unknown>;
  if (typeof agentDid !== 'string' || !agentDid ||
      typeof principalDid !== 'string' || !principalDid) {
    return NextResponse.json({ error: 'Missing agentDid or principalDid' }, { status: 400 });
  }

  try {
    const result = await resolveAgentAuthority(agentDid, principalDid);
    return NextResponse.json({ allowed: result.allowed, via: result.via, grantId: result.grantId });
  } catch (err) {
    // A lookup failure is not an authorization. Deny, and say so loudly enough
    // that a broken database does not read as "this agent has no delegation".
    log.error({ err: String(err) }, 'verify-delegation lookup failed');
    return NextResponse.json({ allowed: false, error: 'Lookup failed' }, { status: 500 });
  }
}
