import { NextRequest } from 'next/server';
import { requireAuth, isInGraph } from '@/lib/auth';
import { getCapabilities } from '@/lib/capabilities';
import { errorResponse } from '@/lib/utils';

/**
 * GET /api/capabilities - Return current user's capabilities based on identity tier
 */
export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { identity } = authResult;
  const tier = identity.tier ?? 'hard';

  let inGraph = false;
  if (tier === 'hard') {
    inGraph = await isInGraph(identity.id);
  }

  const caps = getCapabilities({ tier, inGraph });

  return Response.json({
    tier,
    inGraph,
    capabilities: Array.from(caps),
  });
}
