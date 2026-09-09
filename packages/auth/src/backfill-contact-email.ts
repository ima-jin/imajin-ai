import { createLogger } from '@imajin/logger';
import { postInternal } from './internal-post';

const log = createLogger('auth');

export interface ContactEmailBackfillResult {
  did: string;
  contactEmail: string | null;
  backfilled: boolean;
}

/**
 * Service-to-service call to the kernel's `POST /auth/api/identity/:did/contact`
 * (#2058) — the single owner of the `auth.identities.contact_email` write.
 * Replaces the raw `UPDATE ... WHERE contact_email IS NULL` that
 * apps/events' `contact-email.ts` used to run directly against the shared
 * Postgres database (the last app-side write into the kernel's identity
 * table flagged by the #1983 extraction audit; #1999/#2053 moved the
 * sibling check-in CAS write the same way).
 *
 * NULL-guarded / idempotent server-side: calling this repeatedly for the
 * same DID is always safe — once a contact_email is on file, later calls
 * report `backfilled: false` and perform no write. Mirrors
 * evaluateEligibility's transport (Bearer `ATTESTATION_INTERNAL_API_KEY`,
 * same fire-and-forget calling convention): callers should never block a
 * user-facing response on this. Never throws — returns `null` when the
 * call could not be completed (misconfiguration or transport/HTTP error).
 */
export async function backfillContactEmail(did: string, email: string): Promise<ContactEmailBackfillResult | null> {
  try {
    const outcome = await postInternal<ContactEmailBackfillResult>(
      `/api/identity/${encodeURIComponent(did)}/contact`,
      { email },
    );
    if (!outcome) {
      log.warn({}, 'Contact email backfill skipped: AUTH_SERVICE_URL or ATTESTATION_INTERNAL_API_KEY not set');
      return null;
    }
    if (!outcome.ok) {
      log.warn({ did, status: outcome.status }, 'Contact email backfill rejected');
      return null;
    }
    return outcome.data;
  } catch (err) {
    log.error({ err: String(err), did }, 'Contact email backfill error');
    return null;
  }
}
