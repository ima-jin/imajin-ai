import { NextRequest, NextResponse } from 'next/server';
import { db, identities, profiles, invitesInConnections as invites, podsInConnections as pods, podMembersInConnections as podMembers, connections, contacts, mailingLists, subscriptions } from '@/src/db';
import { eq, or, sql } from 'drizzle-orm';
import { didFromPublicKey, verifySignature } from '@/src/lib/auth/crypto';
import { createSessionToken, getSessionCookieOptions } from '@/src/lib/auth/jwt';
import { rateLimit, getClientIP } from '@/src/lib/kernel/rate-limit';
import { generateId } from '@/src/lib/kernel/utils';
import { getNodeDid } from '@/src/lib/kernel/node-identity';
import { emitAttestation } from '@imajin/auth';
import { notify } from '@imajin/notify';
import { sendEmail } from '@imajin/email';
import { generateVerifyToken, verifyTokenExpiry } from '@/src/lib/www/subscribe-tokens';
import { verificationEmail, verificationEmailText } from '@/src/lib/www/verify-email-template';
import { createLogger } from '@imajin/logger';
import { createEmitter } from '@imajin/events';

const log = createLogger('kernel');
const events = createEmitter('kernel');

/**
 * POST /api/register
 * Register a new identity with a public key.
 * REQUIRES a valid invite code (invite-only platform).
 * 
 * Body: {
 *   publicKey: string (hex),
 *   handle?: string,
 *   name?: string,
 *   scope?: 'actor' | 'family' | 'community' | 'business' (default: 'actor'),
 *   subtype?: string (default: 'human' for actor scope),
 *   signature: string (hex) - signs the payload,
 *   inviteCode?: string - required for new registrations
 * }
 */
export async function POST(request: NextRequest) {
  const ip = getClientIP(request);
  const rl = rateLimit(ip, 5, 60_000);
  if (rl.limited) {
    return NextResponse.json(
      { error: 'Too many requests', retryAfter: rl.retryAfter },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } }
    );
  }

  try {
    const body = await request.json();
    const { publicKey, handle, name, scope: rawScope, subtype: rawSubtype, signature, inviteCode, email, phone, optInUpdates } = body;
    const scope = rawScope || 'actor';
    const subtype = rawSubtype || (scope === 'actor' ? 'human' : null);

    // Validate required fields
    if (!publicKey || typeof publicKey !== 'string') {
      return NextResponse.json(
        { error: 'publicKey required (Ed25519 hex)' },
        { status: 400 }
      );
    }

    // Valid identity scopes
    const VALID_SCOPES = ['actor', 'family', 'community', 'business'];
    if (!VALID_SCOPES.includes(scope)) {
      return NextResponse.json(
        { error: `scope must be one of: ${VALID_SCOPES.join(', ')}` },
        { status: 400 }
      );
    }

    // Validate handle format if provided
    if (handle) {
      if (!/^[a-z0-9_]{3,30}$/.test(handle)) {
        return NextResponse.json(
          { error: 'Handle must be 3-30 lowercase letters, numbers, or underscores' },
          { status: 400 }
        );
      }
    }

    // Verify signature
    if (!signature) {
      return NextResponse.json(
        { error: 'signature required' },
        { status: 400 }
      );
    }

    // The message being signed is the registration payload
    const payloadToSign = JSON.stringify({
      publicKey,
      handle,
      name,
      scope,
      subtype,
      timestamp: Math.floor(Date.now() / 1000),
    });

    // For registration, we accept any recent timestamp (within 5 minutes)
    // In production, you'd want stricter timestamp validation

    const isValid = await verifySignature(payloadToSign, signature, publicKey);
    if (!isValid) {
      // Also try without timestamp for simpler clients (and legacy type-based payloads)
      const simplePayload = JSON.stringify({ publicKey, handle, name, scope, subtype });
      const isValidSimple = await verifySignature(simplePayload, signature, publicKey);
      const legacyPayload = JSON.stringify({ publicKey, handle, name, type: rawSubtype || 'human' });
      const isValidLegacy = !isValidSimple && await verifySignature(legacyPayload, signature, publicKey);
      if (!isValidSimple && !isValidLegacy) {
        return NextResponse.json(
          { error: 'Invalid signature' },
          { status: 401 }
        );
      }
    }

    // Check if publicKey or handle already registered
    const conditions = [eq(identities.publicKey, publicKey)];
    if (handle) {
      conditions.push(eq(identities.handle, handle));
    }

    const existing = await db
      .select()
      .from(identities)
      .where(or(...conditions))
      .limit(1);

    if (existing.length > 0) {
      if (existing[0].publicKey === publicKey) {
        // Same key - return existing identity (login-via-register flow)
        let existingDfosLinked = false;
        if (body.dfosChain) {
          try {
            const { verifyClientChain, storeDfosChain } = await import('@/src/lib/auth/dfos');
            const verified = await verifyClientChain(body.dfosChain, publicKey);
            if (verified) {
              existingDfosLinked = await storeDfosChain(existing[0].id, verified);
            }
          } catch (err) {
            log.error({ err: String(err), did: existing[0].id }, '[register] DFOS bridge failed');
          }
        }

        const token = await createSessionToken({
          sub: existing[0].id,
          handle: existing[0].handle || undefined,
          scope: existing[0].scope,
          subtype: existing[0].subtype || undefined,
          name: existing[0].name || undefined,
          tier: (existing[0].tier as 'soft' | 'preliminary' | 'established') || 'preliminary',
        });

        const cookieConfig = getSessionCookieOptions();
        const response = NextResponse.json({
          did: existing[0].id,
          handle: existing[0].handle,
          scope: existing[0].scope,
          subtype: existing[0].subtype,
          created: false,
          message: 'Identity already exists',
          dfosChainLinked: existingDfosLinked,
        });

        response.cookies.set(cookieConfig.name, token, cookieConfig.options);
        return response;
      } else {
        // Handle taken by different key
        return NextResponse.json(
          { error: 'Handle already taken' },
          { status: 409 }
        );
      }
    }

    // Require invite code for new registrations (skip in dev with DISABLE_INVITE_GATE=true)
    // Service-to-service registrations (events, agents, etc.) bypass the invite gate
    const inviteGateDisabled = process.env.NEXT_PUBLIC_DISABLE_INVITE_GATE === 'true';
    const isServiceRegistration = scope !== 'actor' || (subtype && subtype !== 'human');
    let inviteData: { fromDid: string; fromHandle?: string } | null = null;

    if (!isServiceRegistration && inviteCode) {
      // Always look up the invite if one was provided — even with gate disabled
      // This ensures auto-accept creates the connection from the invite
      const [invite] = await db
        .select()
        .from(invites)
        .where(eq(invites.code, inviteCode))
        .limit(1);

      if (invite && invite.status === 'pending' && invite.usedCount < invite.maxUses) {
        inviteData = { fromDid: invite.fromDid, fromHandle: invite.fromHandle ?? undefined };
      } else if (!inviteGateDisabled) {
        // Only reject invalid invites when the gate is enforced
        return NextResponse.json(
          { error: invite?.usedCount >= invite?.maxUses ? 'This invite has already been used' : 'Invalid or expired invite code' },
          { status: 403 }
        );
      }
    } else if (!inviteGateDisabled && !isServiceRegistration) {
      // Gate is enforced and no invite code provided
      return NextResponse.json(
        { error: 'Imajin is invite-only. You need an invite code to register.' },
        { status: 403 }
      );
    }

    // Generate DID from public key
    const did = didFromPublicKey(publicKey);

    // Create identity
    const [identity] = await db
      .insert(identities)
      .values({
        id: did,
        scope,
        subtype: subtype || null,
        publicKey,
        handle: handle || null,
        name: name?.trim().slice(0, 100) || null,
        tier: 'preliminary',
      })
      .returning();

    // Store DFOS chain if provided
    let dfosChainLinked = false;
    if (body.dfosChain) {
      try {
        const { verifyClientChain, storeDfosChain } = await import('@/src/lib/auth/dfos');
        const verified = await verifyClientChain(body.dfosChain, publicKey);
        if (verified) {
          dfosChainLinked = await storeDfosChain(identity.id, verified);
        } else {
          log.warn({ did: identity.id }, '[register] DFOS chain verification failed — skipping');
        }
      } catch (err) {
        log.error({ err: String(err), did: identity.id }, '[register] DFOS chain storage failed');
        // Non-fatal — registration still succeeds
      }
    }

    // Create session token
    const token = await createSessionToken({
      sub: identity.id,
      handle: identity.handle || undefined,
      scope: identity.scope,
      subtype: identity.subtype || undefined,
      name: identity.name || undefined,
      tier: 'preliminary', // registrations with public keys are preliminary DIDs
    });

    // Set cookie first so the accept call is authenticated
    const cookieConfig = getSessionCookieOptions();
    const response = NextResponse.json({
      did: identity.id,
      handle: identity.handle,
      scope: identity.scope,
      subtype: identity.subtype,
      created: true,
      inviteAccepted: false,
      dfosChainLinked,
    }, { status: 201 });

    response.cookies.set(cookieConfig.name, token, cookieConfig.options);

    events.emit({ action: 'identity.register', did: identity.id, payload: { scope: identity.scope, subtype: identity.subtype, tier: 'preliminary' } });

    // Emit identity.created attestation → triggers 10 MJN emission
    emitAttestation({
      issuer_did: identity.id,
      subject_did: identity.id,
      type: 'identity.created',
      context_id: identity.id,
      context_type: 'identity',
      payload: { tier: 'preliminary', scope: identity.scope, subtype: identity.subtype },
    }).catch((err) => log.error({ err: String(err) }, '[register] Attestation (identity.created) error (non-fatal)'));

    // Emit identity.verified.preliminary → triggers 100 MJN emission
    // Key-based registrations are preliminary by definition (proved key ownership).
    // checkPreliminaryEligibility only fires for 'soft' tier, so we emit directly here.
    const platformDid = await getNodeDid();
    emitAttestation({
      issuer_did: platformDid,
      subject_did: identity.id,
      type: 'identity.verified.preliminary',
      context_id: identity.id,
      context_type: 'identity',
      payload: { tier: 'preliminary', scope: identity.scope, subtype: identity.subtype },
    }).catch((err) => log.error({ err: String(err) }, '[register] Attestation (identity.verified.preliminary) error (non-fatal)'));

    // Create profile row so the user is visible/discoverable
    try {
      await db.insert(profiles).values({
        did: identity.id,
        displayName: name?.trim().slice(0, 100) || handle || 'Anonymous',
        handle: handle || null,
        contactEmail: email?.trim() || null,
        phone: phone?.trim() || null,
        metadata: { optInUpdates: optInUpdates || false },
      }).onConflictDoNothing();
    } catch (err) {
      log.error({ err: String(err) }, 'Profile creation failed (non-fatal)');
      // Non-fatal — user can still use the platform, profile can be created later
    }

    // Subscribe to mailing list if opted in — fire and forget, non-fatal
    if (optInUpdates && email && typeof email === 'string' && email.trim()) {
      (async () => {
        try {
          const normalizedEmail = email.toLowerCase().trim();
          const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || process.env.NEXT_PUBLIC_WWW_URL || process.env.WWW_URL || new URL(request.url).origin;

          // Get or create the default mailing list
          let defaultList = await db.query.mailingLists.findFirst({
            where: eq(mailingLists.slug, 'updates'),
          });
          if (!defaultList) {
            const [newList] = await db.insert(mailingLists).values({
              slug: 'updates',
              name: 'Imajin Updates',
              description: 'Progress updates on sovereign infrastructure',
            }).returning();
            defaultList = newList;
          }

          // Check for existing contact
          const existingContact = await db.query.contacts.findFirst({
            where: eq(contacts.email, normalizedEmail),
          });

          if (existingContact) {
            const existingSub = await db.query.subscriptions.findFirst({
              where: eq(subscriptions.contactId, existingContact.id),
            });
            if (!existingSub) {
              await db.insert(subscriptions).values({
                contactId: existingContact.id,
                mailingListId: defaultList.id,
              });
            } else if (existingSub.status !== 'subscribed') {
              await db.update(subscriptions)
                .set({ status: 'subscribed', subscribedAt: new Date(), unsubscribedAt: null })
                .where(eq(subscriptions.id, existingSub.id));
            }
            if (!existingContact.isVerified) {
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
          } else {
            // Create contact and subscription, then send verification email
            const [newContact] = await db.insert(contacts).values({
              email: normalizedEmail,
              source: 'register',
              isVerified: false,
            }).returning();

            await db.insert(subscriptions).values({
              contactId: newContact.id,
              mailingListId: defaultList.id,
            });

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
        } catch (err) {
          log.error({ err: String(err) }, '[register] Mailing list subscription failed (non-fatal)');
        }
      })().catch((err) => log.error({ err: String(err) }, '[register] Mailing list subscription setup error'));
    }

    // Auto-accept the invite (create the connection)
    // We do this server-side so the new user lands with their first connection
    if (inviteData && inviteCode) {
      try {
        const podId = generateId('pod_');
        const senderLabel = inviteData.fromHandle || inviteData.fromDid.slice(0, 16);
        const accepterLabel = identity.handle || identity.id.slice(0, 16);

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

        const [connDidA, connDidB] = [inviteData.fromDid, identity.id].sort((a, b) => a.localeCompare(b));
        await db.insert(connections).values({ didA: connDidA, didB: connDidB })
          .onConflictDoUpdate({
            target: [connections.didA, connections.didB],
            set: { disconnectedAt: null, connectedAt: new Date() },
          });

        events.emit({ action: 'connection.create', did: identity.id, payload: { otherDid: inviteData.fromDid, source: 'invite' } });

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

        emitAttestation({
          issuer_did: identity.id,
          subject_did: inviteData.fromDid,
          type: 'connection.accepted',
          context_id: podId,
          context_type: 'connection',
          payload: { invite_code: inviteCode },
        }).catch((err) => log.error({ err: String(err) }, '[register] Attestation (connection.accepted) error (non-fatal)'));

        emitAttestation({
          issuer_did: inviteData.fromDid,
          subject_did: identity.id,
          type: 'vouch',
          context_id: podId,
          context_type: 'connection',
          payload: { invite_code: inviteCode },
        }).catch((err) => log.error({ err: String(err) }, '[register] Attestation (vouch) error (non-fatal)'));

        // Notify inviter — fire and forget
        (async () => {
          const [inviterProfile] = await db
            .select()
            .from(profiles)
            .where(eq(profiles.did, inviteData.fromDid))
            .limit(1);

          notify.send({
            to: inviteData.fromDid,
            scope: 'connection:invite-accepted',
            data: {
              ...(inviterProfile?.contactEmail && { email: inviterProfile.contactEmail }),
              name: identity.handle || identity.id.slice(0, 16),
            },
          }).catch((err: unknown) => log.error({ err: String(err) }, '[register] Notify error (non-fatal)'));
        })().catch((err: unknown) => log.error({ err: String(err) }, '[register] Notify setup error (non-fatal)'));

        const acceptedResponse = NextResponse.json({
          did: identity.id,
          handle: identity.handle,
          scope: identity.scope,
          subtype: identity.subtype,
          created: true,
          inviteAccepted: true,
          dfosChainLinked,
        }, { status: 201 });
        acceptedResponse.cookies.set(cookieConfig.name, token, cookieConfig.options);
        return acceptedResponse;
      } catch (err) {
        log.error({ err: String(err) }, '[register] Auto-accept failed (non-fatal)');
        // Registration succeeded but auto-accept failed — they can accept manually
        return response;
      }
    }

    return response;

  } catch (error) {
    log.error({ err: String(error) }, 'Register error');
    return NextResponse.json(
      { error: 'Failed to register identity' },
      { status: 500 }
    );
  }
}
