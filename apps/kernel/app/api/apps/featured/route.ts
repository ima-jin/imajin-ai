/**
 * POST /api/apps/featured — operator-self-only curation proposal.
 * No registry mutation occurs until a countersigned approve on /jin.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@imajin/auth';
import { eq } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';
import { db, registryApps } from '@/src/db';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { generateId } from '@/src/lib/kernel/id';
import { actAsRefusal } from '@/src/lib/notify/act-as-guard';
import { getOperatorDid, isOperatorIdentity, computeApprovalContentHash } from '@/src/lib/notify/operator-approvals';
import { recordApprovalRequested } from '@/src/lib/notify/operator-approvals-service';
import { APPS_FEATURED_KIND, parseAppFeaturedDetail } from '@/src/lib/apps/featured-kind';
import { findPendingFeaturedProposal } from '@/src/lib/apps/featured';

const log = createLogger('kernel:apps-featured-route');
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);
  const auth = await requireAuth(request);
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status, headers: cors });
  }
  const refusal = actAsRefusal(auth.identity, cors);
  if (refusal) return refusal;
  const operatorDid = await getOperatorDid();
  if (!operatorDid || !isOperatorIdentity(auth.identity, operatorDid)) {
    return NextResponse.json({ error: 'Only the node operator may propose featuring apps' }, { status: 403, headers: cors });
  }
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: cors });
  }
  const input = parseAppFeaturedDetail(raw);
  if (!input) {
    return NextResponse.json({ error: 'appDid and a boolean featured are required' }, { status: 400, headers: cors });
  }
  try {
    const [app] = await db.select({ name: registryApps.name, status: registryApps.status })
      .from(registryApps).where(eq(registryApps.appDid, input.appDid));
    if (!app) return NextResponse.json({ error: 'Unknown app DID' }, { status: 404, headers: cors });
    if (input.featured && app.status !== 'active') {
      return NextResponse.json({ error: 'App is not active' }, { status: 409, headers: cors });
    }
    const pending = await findPendingFeaturedProposal(input);
    if (pending) {
      return NextResponse.json({ status: 'pending', proposalId: pending.proposalId }, { headers: cors });
    }
    const proposalId = generateId('appfeature');
    const summary = `${input.featured ? 'Feature' : 'Unfeature'} app '${app.name}' (${input.appDid}) in the app directory`;
    const detail = { ...input, appName: app.name };
    const payload = { proposalId, source: 'apps', kind: APPS_FEATURED_KIND, summary, keysTouched: [], detail };
    await recordApprovalRequested({
      ...payload,
      operatorDid,
      contentHash: computeApprovalContentHash(payload),
      notificationId: null,
      signerDid: null,
    });
    return NextResponse.json({ status: 'pending', proposalId }, { status: 201, headers: cors });
  } catch (err) {
    log.error({ err: String(err), appDid: input.appDid }, 'Failed to raise featured proposal');
    return NextResponse.json({ error: 'Failed to raise featured proposal' }, { status: 500, headers: cors });
  }
}

export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';
