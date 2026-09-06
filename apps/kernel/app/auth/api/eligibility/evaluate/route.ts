/**
 * POST /auth/api/eligibility/evaluate
 *
 * Service-to-service endpoint that (re-)evaluates whether a DID is eligible
 * for the hard (established) verification tier — connections ≥25, handle
 * claimed ≥4 weeks ago, ≥1 `event.attendance` attestation — and performs the
 * atomic tier upgrade + attestation emission when eligible (#1999).
 *
 * This is the single owner of the hard-eligibility state machine. It exists
 * so apps never need to re-derive the rule (or read/write `auth.identities`
 * directly) themselves — see apps/events' check-in route, the worst offender
 * called out in the #1983 extraction audit.
 *
 * Authenticated the same way as POST /api/attestations/internal: a Bearer
 * token equal to `ATTESTATION_INTERNAL_API_KEY`. No session cookie — the
 * caller (e.g. an event check-in) is acting on a service's own behalf, not
 * relaying a session belonging to the DID being evaluated.
 *
 * Idempotent: safe to call repeatedly for the same DID. Once already
 * upgraded (or never eligible), this is a no-op that just reports the
 * current tier.
 *
 * Body: { did: string }
 */

import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@imajin/logger';
import { checkHardEligibility } from '@/src/lib/kernel/verification';

const log = createLogger('kernel');

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  const apiKey = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
  const expectedKey = process.env.ATTESTATION_INTERNAL_API_KEY;

  if (!expectedKey || apiKey !== expectedKey) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { did } = body;
  if (!did || typeof did !== 'string') {
    return NextResponse.json({ error: 'did required' }, { status: 400 });
  }

  try {
    const result = await checkHardEligibility(did);
    if (!result.found) {
      return NextResponse.json({ error: 'Identity not found' }, { status: 404 });
    }
    return NextResponse.json({ did, tier: result.tier, upgraded: result.upgraded });
  } catch (err) {
    log.error({ err: String(err), did }, 'Eligibility evaluation failed');
    return NextResponse.json({ error: 'Failed to evaluate eligibility' }, { status: 500 });
  }
}
