import { vaultFieldStatus } from '@/src/lib/vault';
import { configField, oauthVaultField } from './connector';
import { withConnectorConnection } from '@/src/lib/kernel/connector-connection-context';
import { readGoogleSetup } from './setup';
import { isBusinessProfileEnabled } from './features';
import type { GoogleSetupView } from './setup-content';

export async function readGoogleSetupView(ownerDid: string, slot: string): Promise<GoogleSetupView> {
  const [state, config, token] = await Promise.all([
    readGoogleSetup(ownerDid, slot),
    vaultFieldStatus(configField(ownerDid, slot)),
    vaultFieldStatus(oauthVaultField(ownerDid, slot)),
  ]);
  const businessProfileEnabled = isBusinessProfileEnabled();
  const businessProfileApproved = state.steps['business-access'].status === 'approved';
  return {
    ...state, slot, businessProfileEnabled, businessProfileApproved,
    businessProfileAvailable: businessProfileEnabled && businessProfileApproved,
    configSealed: config === 'ready',
    tokenSealed: token === 'ready',
    credentialPending: config === 'pending-grant' || token === 'pending-grant',
  };
}

export interface GoogleSetupCheck {
  status: 'passed' | 'failed';
  checkedAt: string;
  message: string;
}

/** Tests capability, not Google verification/approval. No provider body or credentials escape. */
export async function checkSearchConsoleSetup(ownerDid: string, slot: string): Promise<GoogleSetupCheck> {
  const checkedAt = new Date().toISOString();
  try {
    const { listSites } = await import('./search-console');
    await withConnectorConnection('google', ownerDid, slot, () => listSites(ownerDid));
    return { status: 'passed', checkedAt, message: 'Search Console sites call succeeded. This confirms Search Console API access only, not OAuth verification or Business Profile approval.' };
  } catch {
    return { status: 'failed', checkedAt, message: 'Search Console could not be checked. Select google:search-console:read, seal the OAuth client, connect this slot, and retry. No Google approval has been inferred.' };
  }
}
