/**
 * POST /auth/api/access/knock — KNOCK step of the delegate-grant bearer
 * lifecycle (#2252): a human, logged in with their own session, requests a
 * scoped outbound bearer credential for a static-header client that cannot
 * complete our OAuth+PKCE dance (Meta Muse consumer connector / Muse Code).
 *
 * `principalDid` is always the CALLER's own DID — this is a first-party,
 * logged-in-human action (closer to a GitHub PAT flow's UX, though the
 * result is never a PAT), never something one identity can request on
 * behalf of another. Creates the durable knock record
 * (`createDelegateGrantKnock`, `access.knock` attestation) and raises the
 * decision onto the EXISTING /jin operator-approvals rail (#2059/#2152) —
 * `source: 'access'`, `kind: 'access:bearer-grant'` — mirroring exactly how
 * `POST /jin/api/vault-proposals` raises a vault:* proposal (#2247).
 * Approving that card mints the bearer; see
 * `src/lib/access/approvals-execution.ts`.
 *
 * Body (JSON): {
 *   clientLabel: string,     // e.g. 'Muse Code'
 *   purpose: string,
 *   scopes: string[],        // must be recognized, MCP-carryable scopes
 *   surfaces: string[],      // currently only ['mcp'] is supported end-to-end
 *   slidingWindowDays?: 30 | 90 | 180 | 365,  // default 90
 * }
 * Returns: { requestId, proposalId, expiresAt }
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { generateId } from '@/src/lib/kernel/id';
import { getOperatorDid, computeApprovalContentHash } from '@/src/lib/notify/operator-approvals';
import { recordApprovalRequested } from '@/src/lib/notify/operator-approvals-service';
import { ACCESS_BEARER_GRANT_KIND } from '@/src/lib/access/approvals-execution';
import { createDelegateGrantKnock, validateDelegateGrantKnockInput } from '@/src/lib/access/delegate-grant';

const log = createLogger('kernel:access-knock');

export const dynamic = 'force-dynamic';

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

interface KnockBody {
  clientLabel?: unknown;
  purpose?: unknown;
  scopes?: unknown;
  surfaces?: unknown;
  slidingWindowDays?: unknown;
}

export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }
  const principalDid = authResult.identity.id;

  const operatorDid = await getOperatorDid();
  if (!operatorDid) {
    return NextResponse.json({ error: 'This node has no configured operator to approve the knock' }, { status: 503, headers: cors });
  }

  let body: KnockBody;
  try {
    body = (await request.json()) as KnockBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: cors });
  }

  const clientLabel = typeof body.clientLabel === 'string' ? body.clientLabel : '';
  const purpose = typeof body.purpose === 'string' ? body.purpose : '';
  const scopes = Array.isArray(body.scopes) ? body.scopes : [];
  const surfaces = Array.isArray(body.surfaces) ? body.surfaces : [];
  const slidingWindowDays = typeof body.slidingWindowDays === 'number' ? body.slidingWindowDays : undefined;

  const knockInput = { principalDid, clientLabel, purpose, scopes, surfaces, slidingWindowDays };
  const validation = validateDelegateGrantKnockInput(knockInput);
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400, headers: cors });
  }

  try {
    const knock = await createDelegateGrantKnock(knockInput);
    if (!knock.ok) {
      return NextResponse.json({ error: knock.error }, { status: 400, headers: cors });
    }

    const proposalId = generateId('aprop');
    const summary = `"${clientLabel}" is asking to connect via ${surfaces.join(', ')} for: ${purpose}`;
    const detail = { requestId: knock.requestId, clientLabel, purpose, scopes, surfaces, slidingWindowDays: knock.slidingWindowDays };
    const contentHash = computeApprovalContentHash({
      proposalId,
      source: 'access',
      kind: ACCESS_BEARER_GRANT_KIND,
      summary,
      keysTouched: [],
      detail,
    });

    await recordApprovalRequested({
      proposalId,
      operatorDid,
      source: 'access',
      kind: ACCESS_BEARER_GRANT_KIND,
      summary,
      keysTouched: [],
      detail,
      contentHash,
      notificationId: null,
      // #2337: raised in-process (never via the plugin's signed request
      // contract), so there is no separate requesting-agent DID to capture
      // — `principalDid` above is the caller, but the decided event's
      // existing operator-only delivery is unchanged here.
      signerDid: null,
    });

    return NextResponse.json(
      { requestId: knock.requestId, proposalId, expiresAt: knock.expiresAt },
      { status: 201, headers: cors },
    );
  } catch (err) {
    log.error({ err: String(err), principalDid, clientLabel }, 'Failed to raise delegate-grant knock');
    return NextResponse.json({ error: 'Failed to raise knock request' }, { status: 500, headers: cors });
  }
}
