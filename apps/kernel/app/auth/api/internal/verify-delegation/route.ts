/**
 * POST /auth/api/internal/verify-delegation
 *
 * Internal-only endpoint (guarded by AUTH_INTERNAL_API_KEY) that answers a
 * single question: does `agentDid` hold an active (not revoked) role='agent'
 * membership on `principalDid` in identity_members?
 *
 * ws-server.js calls this to authorize `register_also` (#1653). ws-server is
 * plain CJS running outside Next, so it reaches the database through this route
 * rather than importing drizzle directly — the same shape as the session and
 * ws-token checks it already makes.
 *
 * Fails closed: anything short of a positive match answers `allowed: false`.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, identityMembers } from '@/src/db';
import { eq, and, isNull } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

/** The identity_members role that lets one DID act on another's behalf. */
const AGENT_ROLE = 'agent';

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

  // Check identity_members for an active agent delegation:
  //   identityDid = principalDid (the identity being acted for)
  //   memberDid   = agentDid     (the agent doing the acting)
  //   role        = 'agent'
  //   removedAt IS NULL          (not revoked)
  //
  // identity_members has no surrogate key, so the projection is memberDid; the
  // presence of a row is the entire answer.
  try {
    const [membership] = await db
      .select({ memberDid: identityMembers.memberDid })
      .from(identityMembers)
      .where(
        and(
          eq(identityMembers.identityDid, principalDid),
          eq(identityMembers.memberDid, agentDid),
          eq(identityMembers.role, AGENT_ROLE),
          isNull(identityMembers.removedAt),
        ),
      )
      .limit(1);

    return NextResponse.json({ allowed: Boolean(membership) });
  } catch (err) {
    // A lookup failure is not an authorization. Deny, and say so loudly enough
    // that a broken database does not read as "this agent has no delegation".
    log.error({ err: String(err) }, 'verify-delegation lookup failed');
    return NextResponse.json({ allowed: false, error: 'Lookup failed' }, { status: 500 });
  }
}
