/**
 * Helper functions extracted from the POST /api/register route handler
 * to reduce its cognitive complexity below the S3776 threshold of 15.
 */

import { db, invitesInConnections as invites, podsInConnections as pods, podMembersInConnections as podMembers, connections, profiles, mailingLists, subscriptions, contacts } from '@/src/db';
import { eq, sql } from 'drizzle-orm';
import { verifySignature } from '@/src/lib/auth/crypto';
import { generateId } from '@/src/lib/kernel/utils';
import { sendEmail } from '@imajin/email';
import { generateVerifyToken, verifyTokenExpiry } from '@/src/lib/www/subscribe-tokens';
import { verificationEmail, verificationEmailText } from '@/src/lib/www/verify-email-template';
import { createLogger } from '@imajin/logger';
import * as bus from '@imajin/bus';

const log = createLogger('kernel');

export type InviteData = { fromDid: string; fromHandle?: string };

export type InviteResult =
  | { ok: true; inviteData: InviteData | null }
  | { ok: false; error: string; status: number };

/**
 * Verify a registration signature using three fallback payload forms:
 * 1. Timestamped payload (preferred — prevents replay)
 * 2. Simple payload without timestamp (older clients)
 * 3. Legacy payload using `type` instead of `subtype`
 *
 * Returns true if any form is valid.
 */
export async function verifyRegistrationSignature(
  publicKey: string,
  handle: string | undefined,
  name: string | undefined,
  scope: string,
  subtype: string | null,
  rawSubtype: string | undefined,
  signature: string,
): Promise<boolean> {
  const timestampPayload = JSON.stringify({
    publicKey,
    handle,
    name,
    scope,
    subtype,
    timestamp: Math.floor(Date.now() / 1000),
  });
  if (await verifySignature(timestampPayload, signature, publicKey)) return true;

  const simplePayload = JSON.stringify({ publicKey, handle, name, scope, subtype });
  if (await verifySignature(simplePayload, signature, publicKey)) return true;

  const legacyPayload = JSON.stringify({ publicKey, handle, name, type: rawSubtype ?? 'human' });
  return verifySignature(legacyPayload, signature, publicKey);
}

/**
 * Verify and store a client-submitted DFOS chain for an identity.
 * Non-fatal: logs errors and returns false on any failure.
 */
export async function linkDfosChainSafe(
  identityId: string,
  dfosChain: unknown,
  publicKey: string,
): Promise<boolean> {
  try {
    const { verifyClientChain, storeDfosChain } = await import('@/src/lib/auth/dfos');
    const verified = await verifyClientChain(
      dfosChain as { did: string; log: string[]; operationCID: string },
      publicKey,
    );
    if (!verified) {
      log.warn({ did: identityId }, '[register] DFOS chain verification failed — skipping');
      return false;
    }
    return storeDfosChain(identityId, verified);
  } catch (err) {
    log.error({ err: String(err), did: identityId }, '[register] DFOS chain storage failed');
    return false;
  }
}

/**
 * Look up an invite code and determine whether registration should proceed.
 *
 * Returns:
 *  - { ok: true, inviteData } if the invite is valid or if registration is allowed to proceed without one.
 *  - { ok: false, error, status } if registration must be rejected.
 */
export async function resolveInviteCode(
  inviteCode: string | undefined,
  isServiceRegistration: boolean,
  inviteGateDisabled: boolean,
): Promise<InviteResult> {
  if (isServiceRegistration) {
    // Service identities bypass the invite gate entirely.
    return { ok: true, inviteData: null };
  }

  if (!inviteCode) {
    if (inviteGateDisabled) return { ok: true, inviteData: null };
    return {
      ok: false,
      error: 'Imajin is invite-only. You need an invite code to register.',
      status: 403,
    };
  }

  const [invite] = await db
    .select()
    .from(invites)
    .where(eq(invites.code, inviteCode))
    .limit(1);

  if (invite?.status === 'pending' && invite.usedCount < invite.maxUses) {
    return {
      ok: true,
      inviteData: { fromDid: invite.fromDid, fromHandle: invite.fromHandle ?? undefined },
    };
  }

  if (!inviteGateDisabled) {
    const errorMsg = invite?.usedCount >= invite?.maxUses
      ? 'This invite has already been used'
      : 'Invalid or expired invite code';
    return { ok: false, error: errorMsg, status: 403 };
  }

  // Gate disabled and invite is invalid — allow through without invite linkage.
  return { ok: true, inviteData: null };
}

/**
 * Subscribe an email address to the default mailing list.
 * Fires-and-forgets: does not block the caller and never throws.
 */
export function subscribeEmailToMailingList(
  email: string,
  _did: string,
  requestUrl: string,
): void {
  const normalizedEmail = email.toLowerCase().trim();
  const baseUrl =
    process.env.NEXT_PUBLIC_BASE_URL ??
    process.env.NEXT_PUBLIC_WWW_URL ??
    process.env.WWW_URL ??
    new URL(requestUrl).origin;

  (async () => {
    let defaultList = await db.query.mailingLists.findFirst({
      where: eq(mailingLists.slug, 'updates'),
    });
    if (!defaultList) {
      const [newList] = await db
        .insert(mailingLists)
        .values({
          slug: 'updates',
          name: 'Imajin Updates',
          description: 'Progress updates on sovereign infrastructure',
        })
        .returning();
      defaultList = newList;
    }

    const existingContact = await db.query.contacts.findFirst({
      where: eq(contacts.email, normalizedEmail),
    });

    if (existingContact) {
      await upsertSubscription(existingContact.id, defaultList.id);
      if (!existingContact.isVerified) {
        await sendVerificationEmail(normalizedEmail, baseUrl);
      }
    } else {
      const [newContact] = await db
        .insert(contacts)
        .values({ email: normalizedEmail, source: 'register', isVerified: false })
        .returning();
      await db.insert(subscriptions).values({
        contactId: newContact.id,
        mailingListId: defaultList.id,
      });
      await sendVerificationEmail(normalizedEmail, baseUrl);
    }
  })().catch((err) =>
    log.error({ err: String(err) }, '[register] Mailing list subscription failed (non-fatal)'),
  );
}

async function upsertSubscription(
  contactId: string,
  mailingListId: string,
): Promise<void> {
  const existingSub = await db.query.subscriptions.findFirst({
    where: eq(subscriptions.contactId, contactId),
  });
  if (!existingSub) {
    await db.insert(subscriptions).values({ contactId, mailingListId });
  } else if (existingSub.status !== 'subscribed') {
    await db
      .update(subscriptions)
      .set({ status: 'subscribed', subscribedAt: new Date(), unsubscribedAt: null })
      .where(eq(subscriptions.id, existingSub.id));
  }
}

async function sendVerificationEmail(normalizedEmail: string, baseUrl: string): Promise<void> {
  const expiresAt = verifyTokenExpiry();
  const token = generateVerifyToken(normalizedEmail, expiresAt);
  const verifyUrl = `${baseUrl}/api/subscribe/verify?email=${encodeURIComponent(normalizedEmail)}&token=${token}&expires=${expiresAt}`;
  await sendEmail({
    to: normalizedEmail,
    subject: 'Confirm your email — Imajin',
    html: verificationEmail(verifyUrl),
    text: verificationEmailText(verifyUrl),
  });
}

export interface AutoAcceptInviteParams {
  inviteData: InviteData;
  inviteCode: string;
  identity: { id: string; handle: string | null; scope: string; subtype: string | null };
}

export interface AutoAcceptInviteResult {
  ok: boolean;
  podId?: string;
  error?: unknown;
}

/**
 * Auto-accept an invite: create pod, mutual connection, publish bus events,
 * and mark the invite as accepted.
 *
 * Returns { ok: true, podId } on success or { ok: false, error } on failure.
 */
export async function autoAcceptInvite({
  inviteData,
  inviteCode,
  identity,
}: AutoAcceptInviteParams): Promise<AutoAcceptInviteResult> {
  try {
    const podId = generateId('pod_');
    const senderLabel = inviteData.fromHandle ?? inviteData.fromDid.slice(0, 16);
    const accepterLabel = identity.handle ?? identity.id.slice(0, 16);

    await db.insert(pods).values({
      id: podId,
      name: `${senderLabel} ↔ ${accepterLabel}`,
      ownerDid: inviteData.fromDid,
      type: 'personal',
      visibility: 'private',
    });

    await db.insert(podMembers).values([
      { podId, did: inviteData.fromDid, role: 'member', addedBy: inviteData.fromDid },
      { podId, did: identity.id, role: 'member', addedBy: identity.id },
    ]);

    const [connDidA, connDidB] = [inviteData.fromDid, identity.id].sort((a, b) =>
      a.localeCompare(b),
    );
    await db
      .insert(connections)
      .values({ didA: connDidA, didB: connDidB })
      .onConflictDoUpdate({
        target: [connections.didA, connections.didB],
        set: { disconnectedAt: null, connectedAt: new Date() },
      });

    bus
      .publish('connection.create', {
        issuer: identity.id,
        subject: inviteData.fromDid,
        scope: 'connections',
        payload: { otherDid: inviteData.fromDid, source: 'invite' },
      })
      .catch(() => {});

    const now = new Date().toISOString();
    await db
      .update(invites)
      .set({
        status: 'accepted',
        acceptedAt: now,
        usedCount: sql`${invites.usedCount} + 1`,
        consumedBy: identity.id,
        toDid: identity.id,
      })
      .where(eq(invites.code, inviteCode));

    const [inviterProfile] = await db
      .select()
      .from(profiles)
      .where(eq(profiles.did, inviteData.fromDid))
      .limit(1);

    bus.publish('connection.accepted', {
      issuer: identity.id,
      subject: inviteData.fromDid,
      scope: 'connections',
      payload: {
        invite_code: inviteCode,
        context_id: podId,
        context_type: 'connection',
        name: identity.handle ?? identity.id.slice(0, 16),
        email: inviterProfile?.contactEmail ?? undefined,
      },
    });

    bus.publish('vouch', {
      issuer: inviteData.fromDid,
      subject: identity.id,
      scope: 'connections',
      payload: { invite_code: inviteCode, context_id: podId, context_type: 'connection' },
    });

    return { ok: true, podId };
  } catch (error) {
    return { ok: false, error };
  }
}
