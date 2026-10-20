import { createLogger } from '@imajin/logger';
import { resolveAppOwnerDids, type AppListing } from './app-visibility';

const log = createLogger('kernel:app-consent');

export const PRIVATE_APP_CONSENT_ERROR = 'This private app only allows sign-in by its owning identity and current members.';

interface ConsentApp extends AppListing {
  signInAudience?: string | null;
}

/** Sign-in is independent of discovery. Only an explicit anyone setting widens it. */
export async function canConsentToApp(app: ConsentApp, sessionDid: string): Promise<boolean> {
  if (app.visibility !== 'private') return true;
  if (app.signInAudience === 'anyone') return true;
  if (!app.ownerDid) return false;
  try {
    return (await resolveAppOwnerDids(sessionDid)).has(app.ownerDid);
  } catch {
    log.error({}, 'Private app sign-in membership lookup failed; refusing consent');
    return false;
  }
}
