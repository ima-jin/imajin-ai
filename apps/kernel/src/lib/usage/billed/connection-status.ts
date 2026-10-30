import { billingKeySealed as anthropicSealed, billingKeyPending as anthropicPending, resolveActiveGrant as anthropicGranted } from '@/src/lib/anthropic/billing-connector';
import { billingKeySealed as openaiSealed, billingKeyPending as openaiPending, resolveActiveGrant as openaiGranted } from '@/src/lib/openai/billing-connector';

export interface BillingConnectionStatus {
  provider: string;
  status: 'connected' | 'not connected' | 'awaiting owner approval' | 'scope not granted' | 'unavailable';
}

const providers = [
  { provider: 'anthropic', sealed: anthropicSealed, pending: anthropicPending, granted: anthropicGranted },
  { provider: 'openai', sealed: openaiSealed, pending: openaiPending, granted: openaiGranted },
];

/** Presence/grant checks only: this read model never unseals a credential. */
export function readBillingConnections(ownerDid: string): Promise<BillingConnectionStatus[]> {
  return Promise.all(providers.map(async ({ provider, sealed, pending, granted }): Promise<BillingConnectionStatus> => {
    try {
      if (await pending(ownerDid)) return { provider, status: 'awaiting owner approval' };
      if (!await sealed(ownerDid)) return { provider, status: 'not connected' };
      return { provider, status: await granted(ownerDid, `${provider}:billing`) ? 'connected' : 'scope not granted' };
    } catch {
      return { provider, status: 'unavailable' };
    }
  }));
}
