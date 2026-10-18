import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders, corsOptions, withCors } from '@/src/lib/kernel/cors';
import { requireAuth, resolveActingDid, resolveEffectiveDid } from '@imajin/auth';
import { listConnections } from '@/src/lib/connections/list';
import { canManageRelationshipLabels } from '@/src/lib/connections/relationship-labels';
import { createLogger } from '@imajin/logger';

export const dynamic = 'force-dynamic';
const log = createLogger('kernel');

export function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);
  const auth = await resolveEffectiveDid(request, { scope: 'connections:read' });
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status, headers: cors });
  }

  const resolved = await listConnections(auth.effectiveDid);
  let canManage = false;
  // App read scopes do not authorize org mutations. A failed/stale capability
  // lookup must not remove the existing read capability or accidentally grant edits.
  if (auth.via === 'session') {
    try {
      const session = await requireAuth(request, { service: 'connections' });
      if (!('error' in session) && resolveActingDid(session.identity) === auth.effectiveDid) {
        canManage = await canManageRelationshipLabels(auth.effectiveDid, session.identity);
      }
    } catch (error) {
      log.warn({ err: String(error) }, 'Relationship label capability unavailable');
    }
  }
  return withCors(NextResponse.json({ connections: resolved, canManageRelationshipLabels: canManage }), request);
}
