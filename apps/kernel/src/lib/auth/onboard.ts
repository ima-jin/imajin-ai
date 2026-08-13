/**
 * Helper functions extracted from onboard route handlers to reduce cognitive complexity.
 */

import { NextResponse } from 'next/server';
import { db, identities, credentials, identityMembers, onboardTokens, invites } from '@/src/db';
import { eq, and } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { createSessionToken, getSessionCookieOptions, verifySessionToken } from '@/src/lib/auth/jwt';
import { mintOrAccrueClaimableStub } from '@/src/lib/auth/claimable-stub';
import { createLogger } from '@imajin/logger';
import { buildPublicUrlAbsolute } from '@imajin/config';
import { findClaimableStubDid, verifyClaimantEmail } from '@/src/lib/auth/claimable-stub';

const log = createLogger('kernel');

export type SoftDidResult = {
  did: string;
  identity: typeof identities.$inferSelect;
  /** true when the DID was just minted; false when it already existed */
  created: boolean;
};

/**
 * When the verify token is already used or expired, check whether we can
 * re-issue a session:
 *  - If user has an active session, just redirect.
 *  - If the token was used within the grace window (email scanner protection), re-issue.
 *
 * Returns a NextResponse to return early, or null if normal error handling should proceed.
 */
export async function handleExpiredOrUsedToken(
  token: string,
  existingSession: Awaited<ReturnType<typeof verifySessionToken>> | null,
  cookieConfig: ReturnType<typeof getSessionCookieOptions>,
  defaultRedirectUrl: string,
): Promise<NextResponse | null> {
  // If user already has an active session, just redirect them.
  if (existingSession) {
    const [anyRecord] = await db
      .select()
      .from(onboardTokens)
      .where(eq(onboardTokens.token, token))
      .limit(1);
    return NextResponse.redirect(anyRecord?.redirectUrl ?? defaultRedirectUrl);
  }

  // Check if token exists but was already used.
  const [usedRecord] = await db
    .select()
    .from(onboardTokens)
    .where(eq(onboardTokens.token, token))
    .limit(1);

  if (!usedRecord?.usedAt) return null;

  // Grace window: re-issue if used within the last 60 seconds.
  // Protects against email security scanners (Outlook Safe Links, etc.)
  // that consume the token via GET before the user clicks.
  const usedAgo = Date.now() - new Date(usedRecord.usedAt).getTime();
  const GRACE_MS = 60_000;
  if (usedAgo >= GRACE_MS) return null;

  // Attempt to re-issue a session for the already-verified email.
  const normalizedEmail = usedRecord.email.toLowerCase().trim();
  const [existingCred] = await db
    .select({ did: credentials.did })
    .from(credentials)
    .where(and(eq(credentials.type, 'email'), eq(credentials.value, normalizedEmail)))
    .limit(1);

  if (!existingCred?.did) return null;

  const [identity] = await db
    .select()
    .from(identities)
    .where(eq(identities.id, existingCred.did))
    .limit(1);

  if (!identity) return null;

  const identityTier = (identity.tier ?? 'soft') as 'soft' | 'preliminary' | 'established';
  const sessionToken = await createSessionToken({
    sub: existingCred.did,
    scope: 'actor',
    subtype: 'human',
    tier: identityTier,
    handle: identity.handle ?? undefined,
    name: identity.name ?? undefined,
  });

  const redirectUrl = usedRecord.redirectUrl ?? defaultRedirectUrl;
  const response = NextResponse.redirect(redirectUrl);
  response.cookies.set(cookieConfig.name, sessionToken, cookieConfig.options);
  return response;
}

/**
 * Backfill `name`/`contactEmail` on an identity when they're missing, e.g.
 * an existing record predates one of these fields, or a stub minted
 * elsewhere never had them set. No-op (returns `identity` unchanged) when
 * neither backfill applies. Shared by both branches of
 * {@link createOrFindSoftDid} to keep its own cognitive complexity down.
 */
async function backfillIdentityContact(
  did: string,
  identity: typeof identities.$inferSelect,
  name: string | null | undefined,
  normalizedEmail: string,
): Promise<typeof identities.$inferSelect> {
  const wantNameUpdate = !!(name && !identity.name);
  const missingEmail = !identity.contactEmail;
  if (!wantNameUpdate && !missingEmail) return identity;

  const [updated] = await db
    .update(identities)
    .set({
      ...(wantNameUpdate ? { name: name! } : {}),
      ...(missingEmail ? { contactEmail: normalizedEmail } : {}),
      updatedAt: new Date(),
    })
    .where(eq(identities.id, did))
    .returning();
  return updated;
}

/**
 * Create a new soft DID for the given email, or return the existing one.
 * Also updates name/contactEmail if the identity is missing them.
 *
 * #1834 Phase 3: the mint half is delegated to the claimable-stub primitive
 * (`mintOrAccrueClaimableStub`) instead of a bespoke insert, so a
 * genuinely-new email here dedupes against any stub already minted for it
 * by another introduction path (connections invite, events checkout, ...)
 * via the HMAC index — "one DID per email" (#1834 design pt. 1) now holds
 * across every mint site. Clicking the onboard magic link IS proof of email
 * ownership (unlike a bare invite-link click, #1834 design pt. 3), so this
 * function still unconditionally inserts a verified `credentials` row
 * itself, exactly as it did before this migration — self-serve onboarding
 * keeps producing an immediately-usable, verified identity regardless of
 * whether an inviter-side countersign ever exists. The bilateral
 * claim/ratchet (`tryActivateClaim`) stays untouched and is not invoked
 * from here.
 */
export async function createOrFindSoftDid(
  normalizedEmail: string,
  name: string | null | undefined,
): Promise<SoftDidResult> {
  const [existingCred] = await db
    .select({ did: credentials.did })
    .from(credentials)
    .where(and(eq(credentials.type, 'email'), eq(credentials.value, normalizedEmail)))
    .limit(1);

  if (existingCred) {
    const [identity] = await db
      .select()
      .from(identities)
      .where(eq(identities.id, existingCred.did))
      .limit(1);

    if (identity) {
      const updated = await backfillIdentityContact(existingCred.did, identity, name, normalizedEmail);
      return { did: existingCred.did, identity: updated, created: false };
    }
  }

  // Mint-or-accrue via the claimable-stub primitive (#1834 Phase 3).
  const { did, isNewStub } = await mintOrAccrueClaimableStub(normalizedEmail);

  const [mintedIdentity] = await db
    .select()
    .from(identities)
    .where(eq(identities.id, did))
    .limit(1);

  if (!mintedIdentity) {
    // Defensive: claim_stub_index.did is a NOT NULL FK into identities, so
    // this shouldn't happen — but never fall through to minting a second
    // DID for the same email if it somehow does.
    throw new Error(`[onboard] claimable stub ${did} has no identities row`);
  }

  const identity = await backfillIdentityContact(did, mintedIdentity, name, normalizedEmail);

  // The onboard magic-link click is itself the email-ownership proof, so
  // insert the verified credential unconditionally — identical to the
  // pre-migration behavior — regardless of whether this stub was freshly
  // minted here or accrued from a prior introduction elsewhere.
  // `onConflictDoNothing` guards the (already unlikely) race where another
  // path inserted the same (type, value) row concurrently.
  await db.insert(credentials).values({
    id: `cred_${nanoid(16)}`,
    did,
    type: 'email',
    value: normalizedEmail,
    verifiedAt: new Date(),
  }).onConflictDoNothing();

  return { did, identity, created: isNewStub };
}

export type OnboardIdentityResult = SoftDidResult & {
  /**
   * True when the Phase-1 bilateral claim ratchet closed as part of this
   * resolution (both the claimant's email verification AND the inviter's
   * countersign are present). False when there was no matching claimable
   * stub, or the ratchet has not (yet) closed — the identity may still be
   * `soft` tier in that case. Mirrors `tryActivateClaim`'s return value.
   */
  claimActivated: boolean;
};

/**
 * Resolve the DID + identity a completed email verification should attach
 * to (#1834 Phase 2).
 *
 * When `normalizedEmail` matches an existing claimable stub
 * (`auth.claim_stub_index`, #1834 Phase 1), this IS the claimant proving
 * ownership of that stub's email — the claimant-side half of the ratchet.
 * Delegates to `verifyClaimantEmail`, which sets `claimant_verified_at` and
 * attempts to close the ratchet (idempotent; still requires the inviter's
 * countersign to already be present via an accepted invite — landing here
 * is never enough on its own). Reuses the SAME DID rather than minting a
 * second, independent one, preserving "one DID per email" (#1834 design
 * pt. 1).
 *
 * Otherwise (no matching stub — a genuinely new email, or one already tied
 * to a real identity), falls back to the pre-existing `createOrFindSoftDid`
 * mint path, unchanged.
 */
export async function resolveOnboardIdentity(
  normalizedEmail: string,
  name: string | null | undefined,
): Promise<OnboardIdentityResult> {
  const stubDid = await findClaimableStubDid(normalizedEmail);
  if (!stubDid) {
    const result = await createOrFindSoftDid(normalizedEmail, name);
    return { ...result, claimActivated: false };
  }

  const claimActivated = await verifyClaimantEmail(normalizedEmail).catch((err: unknown) => {
    log.error({ err: String(err), did: stubDid }, '[onboard] verifyClaimantEmail error (non-fatal)');
    return false;
  });

  const [identity] = await db
    .select()
    .from(identities)
    .where(eq(identities.id, stubDid))
    .limit(1);

  if (!identity) {
    // Defensive: claim_stub_index.did is a NOT NULL FK into identities, so
    // this shouldn't happen — but never fall through to minting a second
    // DID for the same email if it somehow does.
    throw new Error(`[onboard] claimable stub ${stubDid} has no identities row`);
  }

  return { did: stubDid, identity, created: false, claimActivated };
}

/**
 * Resolve the post-verify redirect target (#1834 Phase 2).
 *
 * When the onboarding round trip started from a connections invite
 * (`inviteCode`) that carries a `pendingAttestationId`, AND the Phase-1
 * claim ratchet closed as part of this verification, route the claimant to
 * the record waiting for their countersignature — reusing the existing
 * attestations dashboard (`/auth/attestations`, filtered to attestations
 * about them) rather than building a new view or a new notification path
 * (the counterparty-pending-signature notify contract, #1820/#1821,
 * already covers reminding them). Otherwise falls back to
 * `defaultRedirectUrl` unchanged.
 *
 * Context is always re-resolved from the invite row by `code` — never from
 * a client-supplied query param — per the #1834 Phase 2 "context stays
 * server-side" design. Landing here is navigation only: it does not touch
 * the ratchet or the attestation itself, and the ratchet gate above means
 * an unverified click alone can never reach this branch.
 */
export async function resolveOnboardRedirect(opts: {
  inviteCode: string | null | undefined;
  claimActivated: boolean;
  defaultRedirectUrl: string;
}): Promise<string> {
  const { inviteCode, claimActivated, defaultRedirectUrl } = opts;
  if (!inviteCode || !claimActivated) return defaultRedirectUrl;

  const [invite] = await db
    .select({ pendingAttestationId: invites.pendingAttestationId })
    .from(invites)
    .where(eq(invites.code, inviteCode))
    .limit(1);

  if (!invite?.pendingAttestationId) return defaultRedirectUrl;

  return `${buildPublicUrlAbsolute('auth')}/attestations?role=subject`;
}

/**
 * Add `memberDid` to scope `scopeDid` as a member.
 * Idempotent: re-activates a previously removed membership.
 * Non-fatal: logs on error.
 */
export async function addScopeMembership(
  scopeDid: string,
  memberDid: string,
): Promise<void> {
  try {
    const [existing] = await db
      .select({ removedAt: identityMembers.removedAt })
      .from(identityMembers)
      .where(and(eq(identityMembers.identityDid, scopeDid), eq(identityMembers.memberDid, memberDid)))
      .limit(1);

    if (!existing) {
      await db.insert(identityMembers).values({
        identityDid: scopeDid,
        memberDid,
        role: 'member',
        addedBy: scopeDid,
        addedVia: 'invite',
      });
    } else if (existing.removedAt) {
      await db
        .update(identityMembers)
        .set({ removedAt: null, role: 'member', addedBy: scopeDid, addedVia: 'invite', addedAt: new Date() })
        .where(and(eq(identityMembers.identityDid, scopeDid), eq(identityMembers.memberDid, memberDid)));
    }
    // If existing and not removed: already a member, nothing to do.
  } catch (err) {
    log.error({ err: String(err), scopeDid, memberDid }, '[onboard] Scope membership add failed (non-fatal)');
  }
}
