/**
 * Helper functions extracted from onboard route handlers to reduce cognitive complexity.
 */

import { NextResponse } from 'next/server';
import { db, identities, credentials, identityMembers, onboardTokens } from '@/src/db';
import { eq, and } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { createSessionToken, getSessionCookieOptions, verifySessionToken } from '@/src/lib/auth/jwt';
import { createLogger } from '@imajin/logger';

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
 * Create a new soft DID for the given email, or return the existing one.
 * Also updates name/contactEmail if the identity is missing them.
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
    let [identity] = await db
      .select()
      .from(identities)
      .where(eq(identities.id, existingCred.did))
      .limit(1);

    if (identity) {
      const wantNameUpdate = !!(name && !identity.name);
      const missingEmail = !identity.contactEmail;
      if (wantNameUpdate || missingEmail) {
        [identity] = await db
          .update(identities)
          .set({
            ...(wantNameUpdate ? { name: name! } : {}),
            ...(missingEmail ? { contactEmail: normalizedEmail } : {}),
            updatedAt: new Date(),
          })
          .where(eq(identities.id, existingCred.did))
          .returning();
      }
      return { did: existingCred.did, identity, created: false };
    }
  }

  // Mint a new stable soft DID.
  const did = `did:imajin:${nanoid(44)}`;
  const placeholderKey = `soft_${nanoid(32)}`;
  const [identity] = await db
    .insert(identities)
    .values({
      id: did,
      scope: 'actor',
      subtype: 'human',
      publicKey: placeholderKey,
      handle: null,
      name: name ?? null,
      contactEmail: normalizedEmail,
      metadata: { email: normalizedEmail, tier: 'soft', source: 'onboard' },
    })
    .returning();

  await db.insert(credentials).values({
    id: `cred_${nanoid(16)}`,
    did,
    type: 'email',
    value: normalizedEmail,
    verifiedAt: new Date(),
  });

  return { did, identity, created: true };
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
