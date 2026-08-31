/**
 * POST /consent/api/requests — raise a consent request (#1817).
 *
 * Scope-gated: any app-authed requester holding `consent:write` may raise a
 * request against an explicit approver DID. There is deliberately no
 * fallback to plain session auth here — this primitive is for EXTERNAL
 * systems asking a principal to consent to something, not a human raising a
 * request against themself.
 *
 * requesterDid = the app's own DID (appAuth.appDid), never the delegating
 * user — that is what makes the requester/approver distinction in the
 * persisted record meaningful and unspoofable by the caller.
 *
 * Body (JSON):
 *   {
 *     approverDid?: string,   // defaults to the delegating user (appAuth.userDid)
 *     kind: string,           // requester-vocabulary request kind
 *     summary: string,        // human-readable: exactly what will happen
 *     detail?: object,        // optional structured payload for the card
 *     ttlMs?: number,         // defaults to 15 minutes; clamped to [1m, 24h]
 *   }
 *
 * Response: 201 { request: ConsentRequestCard }
 *
 * GET /consent/api/requests — list the caller's own cards (session auth).
 *
 * Query params:
 *   ?role=approver|requester   — whose cards to list; defaults to 'approver'
 *                                 (the /jin confirm-card dashboard view)
 *   ?status=pending,approved   — comma-separated; defaults to pending,approved,rejected
 *
 * Response: { requests: ConsentRequestCard[] }
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAppAuth, requireAuth, resolveActingDid } from '@imajin/auth';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { createLogger } from '@imajin/logger';
import {
  listConsentRequestCards,
  parseStatusFilter,
  raiseConsentRequest,
} from '@/src/lib/consent-requests/consent-requests';
import type { ConsentRequestRole } from '@/src/lib/consent-requests/types';

const log = createLogger('kernel:consent:requests');

export const dynamic = 'force-dynamic';

const CONSENT_WRITE_SCOPE = 'consent:write';

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  const authResult = await requireAppAuth(request, { scope: CONSENT_WRITE_SCOPE });
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }
  const { appAuth } = authResult;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Request body must be JSON' }, { status: 400, headers: cors });
  }

  const approverDid = isNonEmptyString(body.approverDid)
    ? body.approverDid
    : (appAuth.userDid || undefined);
  if (!approverDid) {
    return NextResponse.json(
      { error: 'approverDid is required (no delegating user on this app token)' },
      { status: 400, headers: cors },
    );
  }
  const kind = body.kind;
  if (!isNonEmptyString(kind)) {
    return NextResponse.json({ error: 'kind is required' }, { status: 400, headers: cors });
  }
  const summary = body.summary;
  if (!isNonEmptyString(summary)) {
    return NextResponse.json(
      { error: 'summary is required — a human-readable description of exactly what will happen' },
      { status: 400, headers: cors },
    );
  }
  const detail = body.detail;
  if (detail !== undefined && detail !== null && !isPlainObject(detail)) {
    return NextResponse.json({ error: 'detail must be a JSON object when provided' }, { status: 400, headers: cors });
  }
  const ttlMs = typeof body.ttlMs === 'number' ? body.ttlMs : undefined;

  try {
    const card = await raiseConsentRequest({
      requesterDid: appAuth.appDid,
      approverDid,
      kind,
      summary,
      detail: isPlainObject(detail) ? detail : null,
      requesterScope: CONSENT_WRITE_SCOPE,
      ttlMs,
    });
    return NextResponse.json({ request: card }, { status: 201, headers: cors });
  } catch (err) {
    log.error({ err: String(err), appDid: appAuth.appDid }, 'raiseConsentRequest failed');
    return NextResponse.json({ error: 'Failed to raise consent request' }, { status: 500, headers: cors });
  }
}

export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }
  const did = resolveActingDid(authResult.identity);

  const url = new URL(request.url);
  const role: ConsentRequestRole = url.searchParams.get('role') === 'requester' ? 'requester' : 'approver';
  const statuses = parseStatusFilter(url.searchParams.get('status'));
  if (statuses === null) {
    return NextResponse.json(
      { error: 'status must be one of: pending, approved, rejected, expired' },
      { status: 400, headers: cors },
    );
  }

  try {
    const requests = await listConsentRequestCards(did, role, statuses);
    return NextResponse.json({ requests }, { headers: cors });
  } catch (err) {
    log.error({ err: String(err), did, role }, '[consent/requests] list failed');
    return NextResponse.json({ error: 'Failed to list consent requests' }, { status: 500, headers: cors });
  }
}
