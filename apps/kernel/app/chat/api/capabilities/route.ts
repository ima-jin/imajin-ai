import { NextRequest } from 'next/server';
import { requireAuth, isInGraph } from '@/src/lib/chat/auth';
import { getCapabilities } from '@/src/lib/chat/capabilities';
import { errorResponse } from '@/src/lib/chat/utils';

/**
 * GET /api/capabilities - Return current user's capabilities based on identity tier
 */
export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { identity } = authResult;
  const tier = identity.tier ?? 'preliminary';

  let inGraph = false;
  if (tier === 'preliminary' || tier === 'established') {
    inGraph = await isInGraph(identity.id);
  }

  const caps = getCapabilities({ tier, inGraph });

  return Response.json({
    tier,
    inGraph,
    capabilities: Array.from(caps),
  });
}
