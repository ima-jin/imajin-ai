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

/**
 * Floor on how long {@link resolveOrMintInviteTarget} takes to return
 * (#1839). Without this, the existing-real-user branch does one query and
 * returns while the mint branch does a query plus two inserts — a caller
 * timing invite-create requests could distinguish "fresh mint" / "accrue to
 * an existing stub" / "email belongs to a real identity" purely from
 * latency, even though the response body is identical across all three.
 * Padding every call up to this floor is the "constant-ish work" mitigation
 * called out in #1839 pt. 3 — not perfect (DB/network variance still leaks
 * a little), but it removes the cheap, structural signal.
 */
const DEFAULT_MIN_RESOLVE_LATENCY_MS = 40;

function minResolveLatencyMs(): number {
  const raw = process.env.CLAIMABLE_STUB_MIN_RESOLVE_MS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MIN_RESOLVE_LATENCY_MS;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait out whatever's left of `floorMs` since `startedAt`. No-op if already past it. */
async function padToFloor(
  startedAt: number,
  floorMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  const remaining = floorMs - (Date.now() - startedAt);
  if (remaining > 0) {
    await sleep(remaining);
  }
}

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
 *
 * Total latency is padded up to {@link minResolveLatencyMs} (#1839 pt. 3) so
 * the three outcomes — resolve-to-existing-real-user, accrue-to-an-existing-
 * stub, mint-a-new-stub — aren't cheaply distinguishable by how fast the
 * call returns, on top of already returning an identical DID-string shape.
 * `sleep` is a test hook only; production callers should never pass it.
 */
export async function resolveOrMintInviteTarget(
  email: string,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<string> {
  const startedAt = Date.now();
  const normalized = normalizeEmail(email);

  const [existingCred] = await db
    .select({ did: credentials.did })
    .from(credentials)
    .where(and(eq(credentials.type, 'email'), eq(credentials.value, normalized)))
    .limit(1);

  const did = existingCred
    ? existingCred.did
    : (await mintOrAccrueClaimableStub(normalized)).did;

  await padToFloor(startedAt, minResolveLatencyMs(), sleep);
  return did;
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

/** Minimal shape any invite-like record needs to be run through {@link withNoDisclosure}. */
interface DiscloseableInvite {
  toDid: string | null;
  status: string;
}

/**
 * Strip the resolved target DID from an invite before it reaches an app or
 * inviter, unless the bilateral claim ratchet has already closed (#1839).
 *
 * Pre-claim, `toDid` is exactly the oracle #1839 exists to close: a stable
 * DID that lets a caller learn "this email already has an Imajin account"
 * (and, worse, use the same DID as a cross-app correlation key). Every
 * pre-claim surface — invite-create, invite list, anything else that reads
 * an invite row — must run it through here before responding.
 *
 * Once `status === 'accepted'`, the app is legitimately a party to the
 * resulting connection (it already learned the counterparty's DID via the
 * accept flow itself), so that disclosure is the human's knob, not a leak
 * (#1839 pt. 4) — the row is returned unchanged.
 */
export function withNoDisclosure<T extends DiscloseableInvite>(invite: T): T {
  return invite.status === 'accepted' ? invite : { ...invite, toDid: null };
}
