import type { Logger } from '@imajin/logger';
import { getClient } from '@imajin/db';
import { backfillContactEmail as backfillContactEmailViaKernel } from '@imajin/auth';

/**
 * Fetch the canonical contact_email for an identity DID.
 * Returns null if the identity doesn't exist or has no contact_email.
 * Errors are caught and logged; never throws.
 *
 * Read-only — stays a direct SQL SELECT (#2058 only moved the write; see
 * backfillContactEmail below).
 */
export async function getContactEmail(
  did: string,
  log: Logger
): Promise<string | null> {
  try {
    const sql = getClient();
    const rows = await sql<{ contact_email: string | null }[]>`
      SELECT contact_email FROM auth.identities WHERE id = ${did} LIMIT 1
    `;
    return rows[0]?.contact_email ?? null;
  } catch (err) {
    log.warn({ err: String(err) }, 'Failed to resolve contact_email');
    return null;
  }
}

/**
 * Backfill auth.identities.contact_email with a NULL guard — never overwrites.
 *
 * Delegates to the kernel's `POST /auth/api/identity/:did/contact` (#2058)
 * instead of writing `auth.identities` directly from this app — the last
 * app-side write into the kernel's identity table flagged by the #1983
 * extraction audit (sibling of #1999/#2053, which moved the check-in
 * route's CAS write behind `POST /auth/api/eligibility/evaluate`).
 * Never throws — a failed/unreachable kernel call is logged as non-fatal,
 * matching the previous try/catch behavior around the raw UPDATE.
 */
export async function backfillContactEmail(
  did: string,
  email: string,
  log: Logger
): Promise<void> {
  const result = await backfillContactEmailViaKernel(did, email);
  if (!result) {
    log.warn({ did }, 'Failed to backfill contact_email via kernel');
  }
}
