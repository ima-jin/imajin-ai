import type { Identity } from '@imajin/auth';
import { enforceRoutePolicy } from '@imajin/auth/delegation-policy';

/** Shared disconnect factory, but each public removal route has an inventory entry. */
export function connectorRemovalPolicy(identity: Identity, provider: string, slot: string): Response | null {
  const options = { resourceId: slot };
  switch (provider) {
    case 'github': return enforceRoutePolicy(identity, 'kernel.github.slot.remove', options);
    case 'google': return enforceRoutePolicy(identity, 'kernel.google.slot.remove', options);
    case 'quickbooks': return enforceRoutePolicy(identity, 'kernel.quickbooks.slot.remove', options);
    default: return Response.json({ error: 'Slot removal is not supported' }, { status: 403 });
  }
}
