/** Read-only balance diagnostics for the existing billed-ingest cron. */
import { listBillingGrantOwners, loadMoonshotBillingCredentials, MOONSHOT_BASE_URL } from '@/src/lib/moonshot/connector';
import { forEachSequential } from '@/src/lib/async/sequential';
import { createMoonshotBalanceReader, type MoonshotBalance } from './moonshot';
import { BillingApiError } from './types';

export interface MoonshotBalanceObservation {
  ownerDid: string;
  billedMode: 'manual-only';
  balance?: MoonshotBalance;
  error?: 'balance_unavailable';
}

export async function readMoonshotBillingBalances(): Promise<MoonshotBalanceObservation[]> {
  // Enumeration failures must not block the other providers or leak DB errors.
  let owners: string[];
  try {
    owners = await listBillingGrantOwners();
  } catch {
    throw new BillingApiError('moonshot', 503, 'Moonshot billing owners unavailable');
  }
  const observations: MoonshotBalanceObservation[] = [];
  await forEachSequential(owners, async (ownerDid) => {
    try {
      const credentials = await loadMoonshotBillingCredentials(ownerDid);
      if (!credentials) return;
      // Regional/custom endpoints may bill in CNY. This reader is USD-only and
      // never forwards a sealed key to an owner-configured arbitrary endpoint.
      if (credentials.baseUrl && credentials.baseUrl.replace(/\/$/, '') !== MOONSHOT_BASE_URL) {
        throw new BillingApiError('moonshot', 400, 'Moonshot balance requires the USD endpoint');
      }
      const balance = await createMoonshotBalanceReader({ apiKey: credentials.apiKey }).fetch();
      observations.push({ ownerDid, billedMode: 'manual-only', balance });
    } catch {
      observations.push({ ownerDid, billedMode: 'manual-only', error: 'balance_unavailable' });
    }
  });
  return observations;
}
