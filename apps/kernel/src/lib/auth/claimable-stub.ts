/**
 * Claimable-stub primitive (#1834 Phase 1).
 *
 * One DID per email, silent merge on repeat introductions, and a ratcheted
 * bilateral claim — implemented here as a small, self-contained primitive
 * wired into the connections-invite flow first. See the ratified design on
 * #1834 for the full rationale; the short version:
 *
 *  1. `resolveOrMintInviteTarget` gives a caller a stable DID for an email
 *     immediately, minting a new soft-tier "stub" identity on first sight of
 *     an email and silently reusing the existing one on every subsequent
 *     sight — with no signal distinguishing the two cases to the caller
 *     (match-without-disclosure).
 *  2. The dedup key is a salted/peppered HMAC-SHA256 of the normalised
 *     email, never the plaintext or a bare hash (dictionary-attackable).
 *  3. The email is still recoverable (for the reminder ladder,
 *     catalyst-power/xprize#75): it's AES-256-GCM-encrypted at rest with a
 *     key derived from the same server secret, stored alongside the HMAC.
 *  4. A stub stays "soft" and unverified until the bilateral claim ratchet
 *     completes: the claimant proves email ownership
 *     (`verifyClaimantEmail`) AND the inviter's side has already
 *     countersigned by way of an accepted invite pointing at the stub's DID
 *     (`tryActivateClaim`, checked from both directions so whichever signal
 *     lands second closes the ratchet).
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { nanoid } from 'nanoid';
import { eq, and } from 'drizzle-orm';
import { db, identities, credentials, claimStubIndex, invitesInConnections as invites } from '@/src/db';
import { emitAttestation } from '@imajin/auth';
import { getNodeDid } from '@/src/lib/kernel/node-identity';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

const AES_ALGO = 'aes-256-gcm';

function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}

function secret(): string {
  const value = process.env.CLAIMABLE_STUB_EMAIL_SECRET;
  if (!value) {
    throw new Error('claimable-stub: CLAIMABLE_STUB_EMAIL_SECRET is not set');
  }
  return value;
}

/**
 * Salted/peppered HMAC-SHA256 match key for an email (#1834 design pt. 2/3).
 * Never reversible; used only for equality matching against
 * `auth.claim_stub_index.email_hmac`.
 */
export function hmacEmail(email: string): string {
  return createHmac('sha256', secret()).update(normalizeEmail(email)).digest('hex');
}

/** 32-byte AES-256 key derived from the server secret, distinct from the HMAC key material above. */
function encryptionKey(): Buffer {
  return createHmac('sha256', secret()).update('claimable-stub-email-encryption').digest();
}

/** Encrypt an email at rest. Format: `{iv}:{authTag}:{ciphertext}`, each base64url. */
function encryptEmail(email: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(AES_ALGO, encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(normalizeEmail(email), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv, authTag, ciphertext].map((b) => b.toString('base64url')).join(':');
}

/** Inverse of {@link encryptEmail}. */
function decryptEmail(encrypted: string): string {
  const [ivB64, tagB64, ciphertextB64] = encrypted.split(':');
  if (!ivB64 || !tagB64 || !ciphertextB64) {
    throw new Error('claimable-stub: malformed encrypted email');
  }
  const decipher = createDecipheriv(AES_ALGO, encryptionKey(), Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, 'base64url')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}

export interface ClaimableStubResult {
  did: string;
  /**
   * True only when this call minted a brand-new stub; false on silent
   * accrual to an existing one. Internal bookkeeping / tests only — callers
   * must never let this change the caller-visible response shape (#1834
   * no-disclosure requirement).
   */
  isNewStub: boolean;
}

/**
 * Mint-or-accrue a claimable stub identity for `email`.
 *
 * A dedup-index hit means some prior introduction already minted a stub for
 * this person — that same DID is returned silently. A miss mints a new
 * soft-tier identity, encrypts the email at rest, and records the HMAC
 * index row.
 */
export async function mintOrAccrueClaimableStub(email: string): Promise<ClaimableStubResult> {
  const emailHmac = hmacEmail(email);

  const [existing] = await db
    .select({ did: claimStubIndex.did })
    .from(claimStubIndex)
    .where(eq(claimStubIndex.emailHmac, emailHmac))
    .limit(1);
  if (existing) {
    return { did: existing.did, isNewStub: false };
  }

  const did = `did:imajin:${nanoid(44)}`;
  await db.insert(identities).values({
    id: did,
    scope: 'actor',
    subtype: 'human',
    publicKey: `stub_${nanoid(32)}`,
    tier: 'soft',
    metadata: { source: 'connections.invite', stub: true },
  });

  await db.insert(claimStubIndex).values({
    emailHmac,
    did,
    emailEncrypted: encryptEmail(email),
  });

  return { did, isNewStub: true };
}

/**
 * Resolve the DID an email invite should target, minting a claimable stub
 * only when no identity already owns this email.
 *
 * Checks the existing plaintext `auth.credentials` index first — the
 * mechanism every other mint site in the kernel already uses (#1833) — so a
 * real, already-onboarded person is never shadowed by a duplicate stub.
 * Only a genuinely new email falls through to
 * {@link mintOrAccrueClaimableStub}.
 */
export async function resolveOrMintInviteTarget(email: string): Promise<string> {
  const normalized = normalizeEmail(email);

  const [existingCred] = await db
    .select({ did: credentials.did })
    .from(credentials)
    .where(and(eq(credentials.type, 'email'), eq(credentials.value, normalized)))
    .limit(1);
  if (existingCred) {
    return existingCred.did;
  }

  const { did } = await mintOrAccrueClaimableStub(normalized);
  return did;
}

/**
 * Find the DID of an existing claimable stub for `email`, without minting a
 * new one (#1834 Phase 2). Returns `null` when no stub exists yet for this
 * email — a genuinely new email, or an email that already belongs to a
 * full, non-stub identity — so callers know to fall back to their own mint
 * path instead. Used by onboarding (`/api/onboard/verify`) so a person
 * completing email verification for an address that was already introduced
 * via a claimable-stub invite resolves to the SAME DID (one DID per email,
 * #1834 design pt. 1) instead of a second, independently-minted soft DID.
 */
export async function findClaimableStubDid(email: string): Promise<string | null> {
  const emailHmac = hmacEmail(email);

  const [stub] = await db
    .select({ did: claimStubIndex.did })
    .from(claimStubIndex)
    .where(eq(claimStubIndex.emailHmac, emailHmac))
    .limit(1);

  return stub?.did ?? null;
}

/**
 * True when `did` is one of our claimable stubs and hasn't been claimed yet
 * (still soft tier). Only stubs we minted are eligible for the
 * link-click-alone accept path in the invite-accept route — an arbitrary
 * soft DID from a different mint site must not be reachable this way.
 */
export async function isUnclaimedStub(did: string): Promise<boolean> {
  const [stub] = await db
    .select({ did: claimStubIndex.did })
    .from(claimStubIndex)
    .where(eq(claimStubIndex.did, did))
    .limit(1);
  if (!stub) return false;

  const [identity] = await db
    .select({ tier: identities.tier })
    .from(identities)
    .where(eq(identities.id, did))
    .limit(1);
  return identity?.tier === 'soft';
}

/**
 * Claimant-side half of the ratchet: mark the stub matching `email` as
 * email-verified, then attempt to close the ratchet.
 *
 * Returns `false` when `email` doesn't match any known stub (nothing to
 * verify); otherwise returns whatever {@link tryActivateClaim} returns.
 */
export async function verifyClaimantEmail(email: string): Promise<boolean> {
  const emailHmac = hmacEmail(email);

  const [stub] = await db
    .select({ did: claimStubIndex.did })
    .from(claimStubIndex)
    .where(eq(claimStubIndex.emailHmac, emailHmac))
    .limit(1);
  if (!stub) return false;

  await db
    .update(claimStubIndex)
    .set({ claimantVerifiedAt: new Date() })
    .where(eq(claimStubIndex.emailHmac, emailHmac));

  return tryActivateClaim(stub.did);
}

/**
 * Inviter-side half check + activation. Bilateral completion requires BOTH:
 *  - the claimant has verified the email (`claim_stub_index.claimant_verified_at`)
 *  - the inviter has countersigned, i.e. at least one invite targeting this
 *    DID has already reached `status = 'accepted'` (the existing
 *    invite-accepted moment that already credits MJN to the inviter,
 *    ratified design pt. 3 — no separate signing action is required of the
 *    inviter).
 *
 * Called from both directions (after verify, and after accept) so whichever
 * signal lands second is the one that closes the ratchet. Idempotent: the
 * tier flip is a CAS on `tier = 'soft'`, so calling this repeatedly (or
 * concurrently) after activation is a safe no-op. The DID never changes —
 * activation only flips `tier` and adds a `credentials` row.
 */
export async function tryActivateClaim(did: string): Promise<boolean> {
  const [stub] = await db
    .select({ claimantVerifiedAt: claimStubIndex.claimantVerifiedAt, emailEncrypted: claimStubIndex.emailEncrypted })
    .from(claimStubIndex)
    .where(eq(claimStubIndex.did, did))
    .limit(1);
  if (!stub?.claimantVerifiedAt) return false;

  const [countersign] = await db
    .select({ id: invites.id })
    .from(invites)
    .where(and(eq(invites.toDid, did), eq(invites.status, 'accepted')))
    .limit(1);
  if (!countersign) return false;

  const [activated] = await db
    .update(identities)
    .set({ tier: 'preliminary', updatedAt: new Date() })
    .where(and(eq(identities.id, did), eq(identities.tier, 'soft')))
    .returning({ id: identities.id });

  if (!activated) return true; // Already activated by a prior/concurrent call.

  const email = decryptEmail(stub.emailEncrypted);
  await db.insert(credentials).values({
    id: `cred_${nanoid(16)}`,
    did,
    type: 'email',
    value: email,
    verifiedAt: new Date(),
  }).onConflictDoNothing();

  const nodeDid = await getNodeDid();
  emitAttestation({
    issuer_did: nodeDid,
    subject_did: did,
    type: 'identity.verified.preliminary',
    context_id: did,
    context_type: 'identity',
  }).catch((err) => log.error({ did, err: String(err) }, '[claimable-stub] claim-activation attestation error'));

  return true;
}
