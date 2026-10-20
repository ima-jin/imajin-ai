/**
 * POST /api/apps/service-scopes — propose operator-approved service scopes
 * for one app (#2711) on the existing operator-approvals rail
 * (#2059/#2152/#2082), alongside `apps:provision` (#2375).
 *
 * Body: { appDid: string, scopes: string[], action?: 'grant' | 'revoke' }
 *
 * The app's owner (or the node operator) may PROPOSE. Nothing changes until
 * the operator countersigns an 'approve' decision on /jin via
 * `POST /jin/api/operator-approvals/:id/decision`, which runs
 * `executeAppsServiceScopesApproval` (`src/lib/apps/service-scopes.ts`). An app
 * can never widen its own service token: this route only stages a card.
 *
 *   - `grant`  (default): add scopes to the app's approved set. Each must be a
 *     vocabulary scope.
 *   - `revoke`: remove scopes from the approved set; the next minted service
 *     token drops them. Each must currently be approved.
 *
 * Idempotent: an identical already-pending proposal is reused rather than
 * raising a duplicate card.
 *
 * GET /api/apps/service-scopes?appDid= — the app's requested and approved sets +
 * the approval id/timestamp of the last change (same owner/operator gate).
 * Without appDid, list registry apps for the node operator, 50 at a time.
 * Continue with the opaque nextCursor in ?cursor=; no provisioning is required.
 */
import { NextRequest, NextResponse } from 'next/server';
import { asc, eq, gt } from 'drizzle-orm';
import { requireAuth, resolveActingDid, validateScopes, type Identity } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { db, registryApps } from '@/src/db';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { generateId } from '@/src/lib/kernel/id';
import { getOperatorDid, isOperatorIdentity, computeApprovalContentHash } from '@/src/lib/notify/operator-approvals';
import { recordApprovalRequested } from '@/src/lib/notify/operator-approvals-service';
import { APPS_SOURCE } from '@/src/lib/apps/approvals-execution';
import { APPS_SERVICE_SCOPES_KIND } from '@/src/lib/apps/service-scopes-kind';
import {
  MAX_SERVICE_SCOPES_PER_PROPOSAL,
  findPendingServiceScopesProposal,
  normalizeScopes,
  parseScopeList,
  type ServiceScopesAction,
} from '@/src/lib/apps/service-scopes';

const log = createLogger('kernel:apps-service-scopes-route');

export const dynamic = 'force-dynamic';
const DISCOVERY_PAGE_SIZE = 50;

function decodeCursor(cursor: string | null): string | null {
  if (cursor === null) return null;
  if (!/^[A-Za-z0-9_-]{1,2048}$/.test(cursor)) throw new Error('Invalid cursor');
  const decoded: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (typeof decoded !== 'string' || !decoded.startsWith('did:imajin:') || decoded.length > 512) {
    throw new Error('Invalid cursor');
  }
  if (Buffer.from(JSON.stringify(decoded)).toString('base64url') !== cursor) throw new Error('Invalid cursor');
  return decoded;
}

async function discoverApps(identity: Identity, params: URLSearchParams, headers: Record<string, string>) {
  const operatorDid = await getOperatorDid();
  if (!operatorDid || identity.actingAs || !isOperatorIdentity(identity, operatorDid)) {
    return NextResponse.json({ error: 'Only the node operator may list registered apps' }, { status: 403, headers });
  }
  let cursor: string | null;
  try {
    cursor = decodeCursor(params.get('cursor'));
  } catch {
    return NextResponse.json({ error: 'Invalid cursor' }, { status: 400, headers });
  }
  try {
    const rows = await db.select({
      appDid: registryApps.appDid,
      name: registryApps.name,
      status: registryApps.status,
      requested: registryApps.requestedScopes,
      approved: registryApps.approvedServiceScopes,
      approvalId: registryApps.serviceScopesApprovalId,
      approvedAt: registryApps.serviceScopesApprovedAt,
    }).from(registryApps)
      .where(cursor ? gt(registryApps.appDid, cursor) : undefined)
      .orderBy(asc(registryApps.appDid))
      .limit(DISCOVERY_PAGE_SIZE + 1);
    const page = rows.slice(0, DISCOVERY_PAGE_SIZE);
    return NextResponse.json({
      apps: page.map(({ requested, approved, ...app }) => ({
        ...app,
        requestedScopes: normalizeScopes(parseScopeList(requested) ?? []),
        approvedServiceScopes: normalizeScopes(parseScopeList(approved) ?? []),
      })),
      nextCursor: rows.length > DISCOVERY_PAGE_SIZE
        ? Buffer.from(JSON.stringify(page[page.length - 1].appDid)).toString('base64url')
        : null,
    }, { headers });
  } catch (err) {
    log.error({ err: String(err) }, 'Failed to list registered app service scopes');
    return NextResponse.json({ error: 'Registered app service scopes are unavailable' }, { status: 503, headers });
  }
}

interface ProposalBody {
  appDid?: unknown;
  scopes?: unknown;
  action?: unknown;
}

type ValidatedBody = { appDid: string; scopes: string[]; action: ServiceScopesAction };

function validateBody(body: ProposalBody): { ok: true; value: ValidatedBody } | { ok: false; error: string } {
  if (typeof body.appDid !== 'string' || body.appDid.length === 0) {
    return { ok: false, error: 'appDid is required' };
  }
  const action = body.action ?? 'grant';
  if (action !== 'grant' && action !== 'revoke') {
    return { ok: false, error: "action must be 'grant' or 'revoke'" };
  }
  const scopes = parseScopeList(body.scopes);
  if (!scopes || scopes.length === 0 || scopes.length > MAX_SERVICE_SCOPES_PER_PROPOSAL) {
    return { ok: false, error: `scopes must be 1-${MAX_SERVICE_SCOPES_PER_PROPOSAL} non-empty strings` };
  }
  if (action === 'grant') {
    const { invalid } = validateScopes(scopes);
    if (invalid.length > 0) {
      return { ok: false, error: `Unknown scopes: ${invalid.join(', ')}` };
    }
  }
  return { ok: true, value: { appDid: body.appDid, scopes, action } };
}

/** The owner of the app, or the node operator, may propose/read. Returns an error response, or null when allowed. */
async function authorizeForApp(
  identity: Identity,
  ownerDid: string,
  cors: Record<string, string>,
): Promise<NextResponse | null> {
  if (resolveActingDid(identity) === ownerDid) return null;
  const operatorDid = await getOperatorDid();
  if (operatorDid && isOperatorIdentity(identity, operatorDid)) return null;
  return NextResponse.json({ error: 'Only the app owner or the node operator may do this' }, { status: 403, headers: cors });
}

export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }
  const proposedByDid = resolveActingDid(authResult.identity);

  let body: ProposalBody;
  try {
    body = (await request.json()) as ProposalBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: cors });
  }
  const validation = validateBody(body);
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400, headers: cors });
  }
  const { appDid, scopes, action } = validation.value;

  const [app] = await db
    .select({
      name: registryApps.name,
      ownerDid: registryApps.ownerDid,
      status: registryApps.status,
      approved: registryApps.approvedServiceScopes,
    })
    .from(registryApps)
    .where(eq(registryApps.appDid, appDid));
  if (!app) {
    return NextResponse.json({ error: 'Unknown app DID' }, { status: 404, headers: cors });
  }
  const denied = await authorizeForApp(authResult.identity, app.ownerDid, cors);
  if (denied) return denied;

  const approvedNow = parseScopeList(app.approved) ?? [];
  if (action === 'grant' && app.status !== 'active') {
    return NextResponse.json({ error: 'App is not active' }, { status: 409, headers: cors });
  }
  if (action === 'grant' && scopes.every((scope) => approvedNow.includes(scope))) {
    return NextResponse.json({ status: 'already-approved', appDid, approvedServiceScopes: approvedNow }, { headers: cors });
  }
  if (action === 'revoke' && !scopes.some((scope) => approvedNow.includes(scope))) {
    return NextResponse.json({ error: 'None of those scopes are currently approved for this app' }, { status: 409, headers: cors });
  }

  const pending = await findPendingServiceScopesProposal({ appDid, action, scopes });
  if (pending) {
    return NextResponse.json({ status: 'pending', proposalId: pending.proposalId }, { headers: cors });
  }

  const operatorDid = await getOperatorDid();
  if (!operatorDid) {
    return NextResponse.json(
      { error: 'No node operator is configured — service scopes require an operator-authority decision' },
      { status: 500, headers: cors },
    );
  }

  const proposalId = generateId('appscope');
  const verb = action === 'grant' ? 'requests' : 'loses';
  const summary = `App '${app.name}' (${appDid}) ${verb} service scopes [${scopes.join(', ')}]`;
  const detail: Record<string, unknown> = {
    appDid,
    appName: app.name,
    action,
    scopes,
    currentlyApproved: approvedNow,
    proposedBy: proposedByDid,
  };
  const contentHash = computeApprovalContentHash({
    proposalId,
    source: APPS_SOURCE,
    kind: APPS_SERVICE_SCOPES_KIND,
    summary,
    keysTouched: [],
    detail,
  });

  try {
    await recordApprovalRequested({
      proposalId,
      operatorDid,
      source: APPS_SOURCE,
      kind: APPS_SERVICE_SCOPES_KIND,
      summary,
      keysTouched: [],
      detail,
      contentHash,
      notificationId: null,
      signerDid: proposedByDid,
    });
    return NextResponse.json({ status: 'pending', proposalId }, { status: 201, headers: cors });
  } catch (err) {
    log.error({ err: String(err), appDid, proposedByDid }, 'Failed to record apps:service-scopes proposal');
    return NextResponse.json({ error: 'Failed to raise apps:service-scopes proposal' }, { status: 500, headers: cors });
  }
}

export async function GET(request: NextRequest) {
  const cors = { ...corsHeaders(request), 'Cache-Control': 'no-store' };

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }

  const params = new URL(request.url).searchParams;
  const appDid = params.get('appDid');
  if (!appDid) {
    return discoverApps(authResult.identity, params, cors);
  }

  const [app] = await db
    .select({
      ownerDid: registryApps.ownerDid,
      requested: registryApps.requestedScopes,
      approved: registryApps.approvedServiceScopes,
      approvalId: registryApps.serviceScopesApprovalId,
      approvedAt: registryApps.serviceScopesApprovedAt,
    })
    .from(registryApps)
    .where(eq(registryApps.appDid, appDid));
  if (!app) {
    return NextResponse.json({ error: 'Unknown app DID' }, { status: 404, headers: cors });
  }
  const denied = await authorizeForApp(authResult.identity, app.ownerDid, cors);
  if (denied) return denied;

  return NextResponse.json(
    {
      appDid,
      requestedScopes: normalizeScopes(parseScopeList(app.requested) ?? []),
      approvedServiceScopes: normalizeScopes(parseScopeList(app.approved) ?? []),
      approvalId: app.approvalId,
      approvedAt: app.approvedAt,
    },
    { headers: cors },
  );
}

export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';
