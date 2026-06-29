/**
 * GET /api/auth/integrations
 *
 * Unified "integrations granted access to my DID" list (#1171) — OAuth/app
 * grants (app.authorized attestations) + bot links (channel_links), enriched
 * with the actor identity (agent badge) and adapter logo. Backs the manage-access
 * surface and the #1170 consent UI.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@imajin/auth';
import { withLogger } from '@imajin/logger';
import { listGrantedIntegrations } from '@/src/lib/auth/integrations';

export const GET = withLogger('kernel', async (request: NextRequest) => {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }

  const integrations = await listGrantedIntegrations(authResult.identity.id);
  return NextResponse.json({ integrations });
});
