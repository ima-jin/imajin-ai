import type { Logger } from '@imajin/logger';
import { getClient } from '@imajin/db';

/**
 * Fetch the canonical contact_email for an identity DID.
 * Returns null if the identity doesn't exist or has no contact_email.
 * Errors are caught and logged; never throws.
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
 * Normalizes (lowercase + trim) before writing.
 * Errors are caught and logged as non-fatal; never throws.
 */
export async function backfillContactEmail(
  did: string,
  email: string,
  log: Logger
): Promise<void> {
  try {
    const sql = getClient();
    const normalizedEmail = email.toLowerCase().trim();
    await sql`
      UPDATE auth.identities
      SET contact_email = ${normalizedEmail}
      WHERE id = ${did} AND contact_email IS NULL
    `;
  } catch (err) {
    log.warn({ err: String(err) }, 'Failed to backfill contact_email');
  }
}
