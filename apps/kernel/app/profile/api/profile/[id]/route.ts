import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { db, profiles, connections, identityMembers, contactHashes, consentGrants } from '@/src/db';
import { requireAuth, requireAppAuth, resolveActingDid } from '@imajin/auth';
import { corsOptions, corsHeaders } from "@/src/lib/kernel/cors";
import { eq, or, and, isNull, count } from 'drizzle-orm';
import { getSessionFromCookies } from '@/src/lib/kernel/session';
import { createLogger } from '@imajin/logger';
import { publish, broker, isBrokerRelease } from '@imajin/bus';
import { validateAgentPricingManifest } from '@imajin/fair';
import { filterProfileFields, FIELD_VISIBILITY_LEVELS } from '@/src/lib/profile';
import type { FieldVisibility } from '@/src/db/schemas/profile';
import { sealAndStore, rotateAndStore, deleteFromVault, loadAndUnseal, vaultService } from '@/src/lib/vault';
import { generateId } from '@/src/lib/kernel/id';

const log = createLogger('kernel');

// Configure ed25519 with sha512 (required for @noble/ed25519 v3)
ed.hashes.sha512 = sha512;

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Decode(str: string): Uint8Array {
  let num = 0n;
  for (const char of str) {
    const idx = BASE58_ALPHABET.indexOf(char);
    if (idx === -1) throw new Error('Invalid base58 character');
    num = num * 58n + BigInt(idx);
  }
  const hex = num.toString(16).padStart(64, '0');
  return new Uint8Array(hex.match(/.{2}/g)!.map(b => Number.parseInt(b, 16)));
}

/** Extract public key bytes from a did:imajin:xxx DID */
function publicKeyFromDid(did: string): Uint8Array | null {
  if (!did.startsWith('did:imajin:')) return null;
  try {
    return base58Decode(did.slice('did:imajin:'.length));
  } catch {
    return null;
  }
}

/** Verify Ed25519 signed request headers */
async function verifySignedRequest(request: NextRequest, body: string): Promise<{ valid: boolean; did?: string; error?: string }> {
  const signature = request.headers.get('x-signature');
  const timestamp = request.headers.get('x-timestamp');
  const did = request.headers.get('x-did');

  if (!signature || !timestamp || !did) {
    return { valid: false, error: 'Missing signature headers' };
  }

  // Reject requests older than 5 minutes
  const age = Date.now() - Number.parseInt(timestamp, 10);
  if (Number.isNaN(age) || age > 5 * 60 * 1000 || age < -30_000) {
    return { valid: false, error: 'Request timestamp out of range' };
  }

  const publicKey = publicKeyFromDid(did);
  if (!publicKey) {
    return { valid: false, error: 'Invalid DID format' };
  }

  const signable = `${timestamp}:${body}`;
  const msgBytes = new TextEncoder().encode(signable);
  const sigBytes = new Uint8Array(signature.match(/.{2}/g)!.map(b => Number.parseInt(b, 16)));

  try {
    const valid = ed.verify(sigBytes, msgBytes, publicKey);
    return valid ? { valid: true, did } : { valid: false, error: 'Invalid signature' };
  } catch {
    return { valid: false, error: 'Signature verification failed' };
  }
}

/** Fields safe to return for profile:read app scope */
function filterProfileForApp(profile: Record<string, any>): Record<string, any> {
  const { did, displayName, handle, avatar, bio, visibility, scope, subtype } = profile;
  return { did, displayName, handle, avatar, bio, visibility, scope, subtype };
}

/** Try to get viewer DID from session cookie (non-blocking) */
async function getViewerDid(request: NextRequest): Promise<string | null> {
  try {
    const session = await getSessionFromCookies(request.headers.get('cookie'));
    return session?.did ?? null;
  } catch { return null; }
}

/** SHA-256 of a normalised (lowercased, trimmed) string for federation hashing. */
function hashContactValue(value: string): string {
  return createHash('sha256').update(value.toLowerCase().trim()).digest('hex');
}

/**
 * Upsert contact hashes for a DID. Pass null for a field to clear its hash.
 * No plaintext is ever stored here — hashes only.
 */
async function upsertContactHashes(
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
 * not already exist. The owner can tighten/widen or revoke via the
 * contact-visibility API. Idempotent — no-op if an active grant already exists.
 */
async function ensureContactConsentGrant(ownerDid: string): Promise<void> {
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

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

/**
 * GET /api/profile/:id - Get profile by DID or handle
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const cors = corsHeaders(request);

  // App auth path — takes precedence over cookie auth if app headers are present
  if (request.headers.get('x-app-did')) {
    const appResult = await requireAppAuth(request, { scope: 'profile:read' });
    if ('error' in appResult) {
      return NextResponse.json({ error: appResult.error }, { status: appResult.status, headers: cors });
    }
    try {
      const profile = await db.query.profiles.findFirst({
        where: (profiles, { eq, or }) =>
          or(eq(profiles.did, id), eq(profiles.handle, id)),
      });
      if (!profile) {
        return NextResponse.json({ error: 'Profile not found' }, { status: 404, headers: cors });
      }
      return NextResponse.json(filterProfileForApp(profile as Record<string, any>), { headers: cors });
    } catch (error) {
      log.error({ err: String(error) }, 'Failed to fetch profile (app auth)');
      return NextResponse.json({ error: 'Failed to fetch profile' }, { status: 500, headers: cors });
    }
  }

  try {
    // Look up by DID or handle
    const profile = await db.query.profiles.findFirst({
      where: (profiles, { eq, or }) =>
        or(eq(profiles.did, id), eq(profiles.handle, id)),
    });

    if (!profile) {
      return NextResponse.json({ error: 'Profile not found' }, { status: 404, headers: cors });
    }

    // Contact info is vault-stored; never return plaintext columns even if they
    // still exist (legacy migration period). Always read from vault.
    const result: Record<string, any> = { ...profile };
    delete result.contactEmail;
    delete result.phone;

    const viewerDid = await getViewerDid(request);

    if (viewerDid === profile.did) {
      // Owner: unseal directly from vault
      const [vaultEmail, vaultPhone] = await Promise.all([
        loadAndUnseal(`contact:email:${profile.did}`).catch(() => undefined),
        loadAndUnseal(`contact:phone:${profile.did}`).catch(() => undefined),
      ]);
      if (vaultEmail) result.contactEmail = vaultEmail;
      if (vaultPhone) result.phone = vaultPhone;
    } else if (viewerDid) {
      // Third-party: broker-gated release (consent → scope → release → audit)
      const unsealed: Record<string, unknown> = {};
      const [e, p] = await Promise.all([
        loadAndUnseal(`contact:email:${profile.did}`).catch(() => undefined),
        loadAndUnseal(`contact:phone:${profile.did}`).catch(() => undefined),
      ]);
      if (e) unsealed['email'] = e;
      if (p) unsealed['phone'] = p;

      if (Object.keys(unsealed).length > 0) {
        try {
          const release = await broker('profile.contact.request', {
            type: 'profile.contact.request',
            requester: viewerDid,
            subject: profile.did,
            fields: Object.keys(unsealed),
            purpose: 'contact.disclosure',
            scope: 'profile',
            data: unsealed,
          });
          if (isBrokerRelease(release)) {
            if (release.data['email']) result.contactEmail = release.data['email'];
            if (release.data['phone']) result.phone = release.data['phone'];
          }
        } catch {
          // Fail-closed: no contact info released on broker error
        }
      }
    }

    // Per-field metadata visibility (#1003): non-owners get a broker-filtered metadata object.
    // Self-queries bypass filtering and see everything.
    if (viewerDid !== profile.did) {
      result.metadata = await filterProfileFields(
        profile.metadata as Record<string, unknown> | null,
        profile.fieldVisibility,
        viewerDid ?? '',
        profile.did,
        log
      );
      // The visibility rules themselves are owner-only config.
      delete result.fieldVisibility;
    }

    // Stub metadata for business profiles
    if (profile.claimStatus) {
      const [{ value: maintainerCount }] = await db
        .select({ value: count() })
        .from(identityMembers)
        .where(
          and(
            eq(identityMembers.identityDid, profile.did),
            eq(identityMembers.role, 'maintainer'),
            isNull(identityMembers.removedAt)
          )
        );
      result.maintainerCount = maintainerCount;

      if (viewerDid) {
        const [isMaintainerRow] = await db
          .select({ identityDid: identityMembers.identityDid })
          .from(identityMembers)
          .where(
            and(
              eq(identityMembers.identityDid, profile.did),
              eq(identityMembers.memberDid, viewerDid),
              eq(identityMembers.role, 'maintainer'),
              isNull(identityMembers.removedAt)
            )
          )
          .limit(1);
        result.isMaintainer = !!isMaintainerRow;
      }
    }

    return NextResponse.json(result, { headers: cors });
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to fetch profile');
    return NextResponse.json({ error: 'Failed to fetch profile' }, { status: 500, headers: cors });
  }
}

/**
 * PUT /api/profile/:id - Update profile (owner only)
 */
export async function PUT(request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const cors = corsHeaders(request);

  // Require authentication
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }

  const { identity } = authResult;

  try {
    // Fetch existing profile
    const existing = await db.query.profiles.findFirst({
      where: (profiles, { eq, or }) =>
        or(eq(profiles.did, id), eq(profiles.handle, id)),
    });

    // Check ownership — allow personal DID or acting-as DID
    const effectiveDid = resolveActingDid(identity);

    if (!existing) {
      // No profile yet — only the identity owner can create it, and the DID must exist in auth.identities
      if (id !== identity.id && id !== effectiveDid) {
        return NextResponse.json({ error: 'Profile not found' }, { status: 404, headers: cors });
      }
      // Verify the DID actually exists as a registered identity
      const { getClient } = await import('@imajin/db');
      const sql = getClient();
      const [identityRow] = await sql`SELECT id FROM auth.identities WHERE id = ${id} LIMIT 1`;
      if (!identityRow) {
        return NextResponse.json({ error: 'Identity not found' }, { status: 404, headers: cors });
      }
      // Will create below after parsing body
    } else if (existing.did !== identity.id && existing.did !== effectiveDid) {
      return NextResponse.json({ error: 'Not authorized to update this profile' }, { status: 403, headers: cors });
    }

    // Clone the request body for signature verification
    const bodyText = await request.text();

    // Verify Ed25519 signed request headers if present
    const sigResult = await verifySignedRequest(request, bodyText);
    if (request.headers.get('x-signature')) {
      // Signature headers are present — enforce verification
      if (!sigResult.valid) {
        return NextResponse.json({ error: `Signature verification failed: ${sigResult.error}` }, { status: 401, headers: cors });
      }
      // Ensure the signing DID matches the authenticated identity
      if (sigResult.did !== identity.id) {
        return NextResponse.json({ error: 'Signature DID does not match authenticated identity' }, { status: 403, headers: cors });
      }
    }

    const body = JSON.parse(bodyText);
    const { displayName, avatar, avatarAssetId, bio, email, phone, visibility, feature_toggles, agentPricing, fieldVisibility } = body;

    // Build update object
    const updates: Record<string, any> = {
      updatedAt: new Date(),
    };

    if (displayName !== undefined) updates.displayName = displayName;
    if (avatar !== undefined) updates.avatar = avatar;
    if (avatarAssetId !== undefined) updates.avatarAssetId = avatarAssetId;
    if (bio !== undefined) updates.bio = bio;

    // Contact info is vault-stored — never write plaintext to DB columns.
    // Always null out the legacy columns and delegate to vault.
    const profileDid = existing?.did || id;
    if (email !== undefined) {
      updates.contactEmail = null; // ensure legacy column stays clear
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
        // Clear email hash; preserve phone hash
        const existing_hashes = await db
          .select({ phoneHash: contactHashes.phoneHash })
          .from(contactHashes)
          .where(eq(contactHashes.did, profileDid))
          .limit(1);
        await upsertContactHashes(profileDid, null, existing_hashes[0]?.phoneHash ?? null);
      }
    }
    if (phone !== undefined) {
      updates.phone = null; // ensure legacy column stays clear
      if (phone) {
        const phoneField = `contact:phone:${profileDid}`;
        const exists = await vaultService.get(phoneField);
        if (exists) {
          await rotateAndStore(phoneField, String(phone));
        } else {
          await sealAndStore(phoneField, String(phone));
        }
        const existing_hashes = await db
          .select({ emailHash: contactHashes.emailHash })
          .from(contactHashes)
          .where(eq(contactHashes.did, profileDid))
          .limit(1);
        await upsertContactHashes(profileDid, existing_hashes[0]?.emailHash ?? null, hashContactValue(String(phone)));
        await ensureContactConsentGrant(profileDid).catch(() => {});
      } else {
        await deleteFromVault(`contact:phone:${profileDid}`);
        const existing_hashes = await db
          .select({ emailHash: contactHashes.emailHash })
          .from(contactHashes)
          .where(eq(contactHashes.did, profileDid))
          .limit(1);
        await upsertContactHashes(profileDid, existing_hashes[0]?.emailHash ?? null, null);
      }
    }
    if (feature_toggles !== undefined) {
      // Merge incoming feature_toggles over existing ones
      updates.featureToggles = { ...(existing?.featureToggles ?? {}), ...feature_toggles };
    }
    if (agentPricing !== undefined) {
      if (agentPricing === null) {
        updates.agentPricing = null;
      } else {
        const validation = validateAgentPricingManifest(agentPricing);
        if (!validation.valid) {
          return NextResponse.json(
            { error: 'Invalid agent pricing manifest', details: validation.errors },
            { status: 400, headers: cors }
          );
        }
        updates.agentPricing = agentPricing;
      }
    }
    if (visibility !== undefined) {
      if (!['public', 'incognito'].includes(visibility)) {
        return NextResponse.json({ error: 'visibility must be public or incognito' }, { status: 400, headers: cors });
      }
      updates.visibility = visibility;
    }
    if (fieldVisibility !== undefined) {
      if (typeof fieldVisibility !== 'object' || fieldVisibility === null || Array.isArray(fieldVisibility)) {
        return NextResponse.json({ error: 'fieldVisibility must be an object' }, { status: 400, headers: cors });
      }
      for (const [field, rule] of Object.entries(fieldVisibility as Record<string, unknown>)) {
        if (typeof rule !== 'object' || rule === null) {
          return NextResponse.json({ error: `fieldVisibility.${field} must be an object` }, { status: 400, headers: cors });
        }
        const { level, allowedDids } = rule as { level?: unknown; allowedDids?: unknown };
        if (typeof level !== 'string' || !FIELD_VISIBILITY_LEVELS.includes(level)) {
          return NextResponse.json(
            { error: `fieldVisibility.${field}.level must be one of ${FIELD_VISIBILITY_LEVELS.join(', ')}` },
            { status: 400, headers: cors }
          );
        }
        if (allowedDids !== undefined && !(Array.isArray(allowedDids) && allowedDids.every((d) => typeof d === 'string'))) {
          return NextResponse.json({ error: `fieldVisibility.${field}.allowedDids must be an array of strings` }, { status: 400, headers: cors });
        }
      }
      updates.fieldVisibility = fieldVisibility as FieldVisibility;
    }

    let updated;
    if (existing) {
      // Update existing profile
      [updated] = await db
        .update(profiles)
        .set(updates)
        .where(eq(profiles.did, existing.did))
        .returning();
    } else {
      // Create new profile for bare identity
      // Note: contactEmail and phone are vault-stored; never written to DB columns.
      [updated] = await db
        .insert(profiles)
        .values({
          did: id,
          displayName: displayName || 'New User',
          avatar: avatar || null,
          bio: bio || null,
          handle: null,
          contactEmail: null,
          phone: null,
          visibility: visibility || 'public',
          featureToggles: feature_toggles || {},
          agentPricing: agentPricing || null,
        })
        .returning();
    }

    publish('profile.update', { issuer: identity.id, subject: identity.id, scope: 'profile', payload: { profileDid } }).catch(() => {});

    return NextResponse.json(updated, { headers: cors });
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to update profile');
    return NextResponse.json({ error: 'Failed to update profile' }, { status: 500, headers: cors });
  }
}

/**
 * DELETE /api/profile/:id - Delete profile (owner only)
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const cors = corsHeaders(request);

  // Require authentication
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }

  const { identity } = authResult;

  try {
    // Fetch existing profile
    const existing = await db.query.profiles.findFirst({
      where: (profiles, { eq, or }) =>
        or(eq(profiles.did, id), eq(profiles.handle, id)),
    });

    if (!existing) {
      return NextResponse.json({ error: 'Profile not found' }, { status: 404, headers: cors });
    }

    // Check ownership
    if (existing.did !== identity.id) {
      return NextResponse.json({ error: 'Not authorized to delete this profile' }, { status: 403, headers: cors });
    }

    // Delete profile
    await db.delete(profiles).where(eq(profiles.did, existing.did));

    return NextResponse.json({ deleted: true }, { headers: cors });
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to delete profile');
    return NextResponse.json({ error: 'Failed to delete profile' }, { status: 500, headers: cors });
  }
}
