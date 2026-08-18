import { getClient } from '@imajin/db';

function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}

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
    WHERE type = 'email' AND value = ${normalizeEmail(email)}
    LIMIT 1
  `;
  return rows[0]?.did ?? null;
}

/**
 * Resolve the DID that owns `email`, consulting every column that
 * independently stores "the" email for a DID, in a single agreed-upon
 * precedence order (#1834 structural-review consolidation proposal; #1858)
 * — so every caller (invite-create's mint decision, invite-accept's
 * identity check, ...) agrees on identity resolution by construction
 * instead of hand-rolling its own credentials-only or contactEmail-only
 * query:
 *
 *  1. `auth.credentials(type='email')` — verified login/registration
 *     email, the authoritative source when present.
 *  2. `profile.profiles.contact_email` — the human's preferred contact
 *     email; may exist even when no credentials row does (e.g. a
 *     keypair-registered user who signed up before #1855's backfill).
 *  3. `auth.identities.contact_email` — a contact email backfilled onto
 *     the identity itself (e.g. from Stripe / ticket metadata) with no
 *     profile row at all.
 *
 * Returns null when no identity owns this email under any of the three.
 */
export async function resolveDidForEmail(email: string): Promise<string | null> {
  const normalized = normalizeEmail(email);
  const sql = getClient();

  const [byCredential] = await sql`
    SELECT did FROM auth.credentials
    WHERE type = 'email' AND value = ${normalized}
    LIMIT 1
  `;
  if (byCredential?.did) return byCredential.did;

  const [byProfile] = await sql`
    SELECT did FROM profile.profiles
    WHERE lower(trim(contact_email)) = ${normalized}
    LIMIT 1
  `;
  if (byProfile?.did) return byProfile.did;

  const [byIdentity] = await sql`
    SELECT id AS did FROM auth.identities
    WHERE lower(trim(contact_email)) = ${normalized}
    LIMIT 1
  `;
  return byIdentity?.did ?? null;
}

/**
 * Inverse of {@link resolveDidForEmail}: resolve the email address that
 * best represents `did`, using the same precedence order (auth.credentials
 * → profile.profiles.contact_email → auth.identities.contact_email).
 * Returns null when none of the three has an email on file for this DID.
 */
export async function resolveEmailForDid(did: string): Promise<string | null> {
  const sql = getClient();

  const [byCredential] = await sql`
    SELECT value FROM auth.credentials
    WHERE did = ${did} AND type = 'email'
    LIMIT 1
  `;
  if (byCredential?.value) return byCredential.value;

  const [byProfile] = await sql`
    SELECT contact_email FROM profile.profiles
    WHERE did = ${did} AND contact_email IS NOT NULL
    LIMIT 1
  `;
  if (byProfile?.contact_email) return byProfile.contact_email;

  const [byIdentity] = await sql`
    SELECT contact_email FROM auth.identities
    WHERE id = ${did} AND contact_email IS NOT NULL
    LIMIT 1
  `;
  return byIdentity?.contact_email ?? null;
}
