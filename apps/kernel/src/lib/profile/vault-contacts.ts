import { createHash } from 'node:crypto';
import { db, contactHashes, consentGrants } from '@/src/db';
import { eq, and } from 'drizzle-orm';
import { sealAndStore, rotateAndStore, deleteFromVault, vaultService } from '@/src/lib/vault';
import { generateId } from '@/src/lib/kernel/id';

/** SHA-256 of a normalised (lowercased, trimmed) string for federation hashing. */
export function hashContactValue(value: string): string {
  return createHash('sha256').update(value.toLowerCase().trim()).digest('hex');
}

/**
 * Upsert contact hashes for a DID. Pass null for a field to clear its hash.
 * No plaintext is ever stored here — hashes only.
 */
export async function upsertContactHashes(
  did: string,
  emailHash: string | null,
  phoneHash: string | null
): Promise<void> {
  await db
    .insert(contactHashes)
    .values({ did, emailHash, phoneHash })
    .onConflictDoUpdate({
      target: contactHashes.did,
      set: { emailHash, phoneHash, updatedAt: new Date() },
    });
}

/**
 * Seed a connections-level consent grant for contact disclosure if one does
 * not already exist. Idempotent — no-op if an active grant already exists.
 */
export async function ensureContactConsentGrant(ownerDid: string): Promise<void> {
  const [existing] = await db
    .select({ id: consentGrants.id })
    .from(consentGrants)
    .where(
      and(
        eq(consentGrants.subject, ownerDid),
        eq(consentGrants.purpose, 'contact.disclosure'),
        eq(consentGrants.status, 'active')
      )
    )
    .limit(1);

  if (existing) return;

  await db.insert(consentGrants).values({
    id: generateId('cg'),
    subject: ownerDid,
    grantedTo: null,
    grantedToClass: 'connections',
    purpose: 'contact.disclosure',
    allowedFields: ['email', 'phone'],
    mode: 'raw',
    status: 'active',
    consentRef: generateId('cref'),
  });
}

/** Store or rotate a vault-encrypted email, update contact hash, and seed consent grant. */
export async function processEmailUpdate(profileDid: string, email: string | null | undefined): Promise<void> {
  if (email === undefined) return;
  if (email) {
    const emailField = `contact:email:${profileDid}`;
    const exists = await vaultService.get(emailField);
    if (exists) {
      await rotateAndStore(emailField, String(email));
    } else {
      await sealAndStore(emailField, String(email));
    }
    await upsertContactHashes(profileDid, hashContactValue(String(email)), null);
    await ensureContactConsentGrant(profileDid).catch(() => {});
  } else {
    await deleteFromVault(`contact:email:${profileDid}`);
    const [row] = await db
      .select({ phoneHash: contactHashes.phoneHash })
      .from(contactHashes)
      .where(eq(contactHashes.did, profileDid))
      .limit(1);
    await upsertContactHashes(profileDid, null, row?.phoneHash ?? null);
  }
}

/** Store or rotate a vault-encrypted phone number, update contact hash, and seed consent grant. */
export async function processPhoneUpdate(profileDid: string, phone: string | null | undefined): Promise<void> {
  if (phone === undefined) return;
  if (phone) {
    const phoneField = `contact:phone:${profileDid}`;
    const exists = await vaultService.get(phoneField);
    if (exists) {
      await rotateAndStore(phoneField, String(phone));
    } else {
      await sealAndStore(phoneField, String(phone));
    }
    const [row] = await db
      .select({ emailHash: contactHashes.emailHash })
      .from(contactHashes)
      .where(eq(contactHashes.did, profileDid))
      .limit(1);
    await upsertContactHashes(profileDid, row?.emailHash ?? null, hashContactValue(String(phone)));
    await ensureContactConsentGrant(profileDid).catch(() => {});
  } else {
    await deleteFromVault(`contact:phone:${profileDid}`);
    const [row] = await db
      .select({ emailHash: contactHashes.emailHash })
      .from(contactHashes)
      .where(eq(contactHashes.did, profileDid))
      .limit(1);
    await upsertContactHashes(profileDid, row?.emailHash ?? null, null);
  }
}
