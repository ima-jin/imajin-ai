import { NextRequest } from 'next/server';
import { enforceRoutePolicy } from '@imajin/auth/delegation-policy';
import { handleOwnershipRoute, type OwnershipParams } from '@/src/lib/auth/ownership-route';

export const dynamic = 'force-dynamic';

export function GET(request: NextRequest, params: OwnershipParams) {
  return handleOwnershipRoute(request, params, 'read');
}

export async function POST(request: NextRequest, params: OwnershipParams) {
  return handleOwnershipRoute(request, params, 'propose', (identity, resourceId, headers) =>
    enforceRoutePolicy(identity, 'identity.owner.propose', { resourceId, headers }));
}

export async function DELETE(request: NextRequest, params: OwnershipParams) {
  return handleOwnershipRoute(request, params, 'cancel', (identity, resourceId, headers) =>
    enforceRoutePolicy(identity, 'identity.owner.cancel', { resourceId, headers }));
}

export { preflight as OPTIONS } from '@/app/auth/lib/preflight';
