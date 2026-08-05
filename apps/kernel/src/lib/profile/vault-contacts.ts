import { createHash } from 'node:crypto';
import { db, contactHashes, consentGrants } from '@/src/db';
import { eq, and } from 'drizzle-orm';
import { sealAndStoreV2, rotateAndStore, deleteFromVault, vaultService } from '@/src/lib/vault';
import { generateId } from '@/src/lib/kernel/id';

/** SHA-256 of a normalised (lowercased, trimmed) string for federation hashing. */
export function hashContactValue(value: string): string {
  return createHash('sha256').update(value.toLowerCase().trim()).digest('hex');
}

/**
 * Announce that a brokered contact field's value changed (#1517).
 *
 * Emitted HERE rather than at each call site so every path that mutates a
 * vault-backed contact value inherits it — the profile PUT route today, and
 * anything added later. The `broker-predicate-invalidation` reactor consumes
 * this to revoke cached predicate claims derived from the field, so a stale
 * claim can never outlive the value it was computed from.
 *
 * Awaited (not fire-and-forget) because the invalidation reactor is registered
 * `await: true`: serving a stale claim about contact data is worse than adding a
 * few milliseconds to the write. Errors are contained — a failed invalidation
 * must not fail the contact write, and the claim's `expiresAt` TTL remains a
 * backstop.
 *
 * Dynamic import mirrors `lib/calendar/index.ts`, keeping the bus off this
 * module's static import graph.
 */
async function publishContactFieldChanged(profileDid: string, field: 'email' | 'phone'): Promise<void> {
  try {
    const { publish } = await import('@imajin/bus');
    await publish('profile.field.changed', {
      issuer: profileDid,
      subject: profileDid,
      scope: 'profile',
      payload: {
        subjectDid: profileDid,
        fields: [field],
        context_id: profileDid,
        context_type: 'profile',
      },
    });
  } catch {
    // Non-fatal: the write is authoritative and the claim TTL still bounds staleness.
  }
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

/**
 * Store or update a vault-encrypted email, update contact hash, and seed
 * consent grant.
 *
 * Initial write goes through `sealAndStoreV2` so the field starts life under
 * delegation-grant custody. Updates to an existing entry go through
 * `rotateAndStore`, which dispatches on the entry's existing custody scheme
 * (imajin-ai#1546) and delegates to `sealAndStoreV2` itself for v2 fields —
 * so a v2 contact field stays v2 across edits without duplicating that logic
 * here.
 */
export async function processEmailUpdate(profileDid: string, email: string | null | undefined): Promise<void> {
  if (email === undefined) return;
  if (email) {
    const emailField = `contact:email:${profileDid}`;
    const exists = await vaultService.get(emailField);
    if (exists) {
      await rotateAndStore(emailField, String(email));
    } else {
      await sealAndStoreV2(emailField, String(email));
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

  // Both branches changed the field: a new value, or its removal. Either way any
  // claim derived from the old value is now wrong.
  await publishContactFieldChanged(profileDid, 'email');
}

/**
 * Store or update a vault-encrypted phone number, update contact hash, and
 * seed consent grant. See {@link processEmailUpdate} for the initial-seal vs.
 * rotate split.
 */
export async function processPhoneUpdate(profileDid: string, phone: string | null | undefined): Promise<void> {
  if (phone === undefined) return;
  if (phone) {
    const phoneField = `contact:phone:${profileDid}`;
    const exists = await vaultService.get(phoneField);
    if (exists) {
      await rotateAndStore(phoneField, String(phone));
    } else {
      await sealAndStoreV2(phoneField, String(phone));
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

  await publishContactFieldChanged(profileDid, 'phone');
}
