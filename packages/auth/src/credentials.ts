import { getClient } from '@imajin/db';

/**
 * Look up the email credential for a DID.
 * Returns null if no email credential exists (e.g. keypair-only DIDs).
 */
export async function getEmailForDid(did: string): Promise<string | null> {
  const sql = getClient();
  const rows = await sql`
    SELECT value FROM auth.credentials
    WHERE did = ${did} AND type = 'email'
    LIMIT 1
  `;
  return rows[0]?.value ?? null;
}

/**
 * Look up the DID that owns a given email credential.
 * Returns null if no identity has registered this email.
 */
export async function getDidForEmail(email: string): Promise<string | null> {
  const sql = getClient();
  const rows = await sql`
    SELECT did FROM auth.credentials
    WHERE type = 'email' AND value = ${email.toLowerCase().trim()}
    LIMIT 1
  `;
  return rows[0]?.did ?? null;
}
