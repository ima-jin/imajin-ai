import { NextRequest } from 'next/server';
import { enforceRoutePolicy } from '@imajin/auth/delegation-policy';
import { handleOwnershipRoute, type OwnershipParams } from '@/src/lib/auth/ownership-route';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, params: OwnershipParams) {
  return handleOwnershipRoute(request, params, 'accept', (identity, resourceId, headers) =>
    enforceRoutePolicy(identity, 'identity.owner.accept', { resourceId, headers }));
}

export { preflight as OPTIONS } from '@/app/auth/lib/preflight';
