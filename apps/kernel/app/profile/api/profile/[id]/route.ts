import { NextRequest, NextResponse } from 'next/server';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { db, profiles, connections, identityMembers } from '@/src/db';
import { requireAuth } from '@imajin/auth';
import { corsOptions, corsHeaders } from "@/src/lib/kernel/cors";
import { eq, or, and, isNull, count } from 'drizzle-orm';
import { getSessionFromCookies } from '@/src/lib/kernel/session';
import { createLogger } from '@imajin/logger';
import { createEmitter } from '@imajin/events';

const log = createLogger('kernel');
const events = createEmitter('profile');

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
  return new Uint8Array(hex.match(/.{2}/g)!.map(b => parseInt(b, 16)));
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
  const age = Date.now() - parseInt(timestamp, 10);
  if (isNaN(age) || age > 5 * 60 * 1000 || age < -30_000) {
    return { valid: false, error: 'Request timestamp out of range' };
  }

  const publicKey = publicKeyFromDid(did);
  if (!publicKey) {
    return { valid: false, error: 'Invalid DID format' };
  }

  const signable = `${timestamp}:${body}`;
  const msgBytes = new TextEncoder().encode(signable);
  const sigBytes = new Uint8Array(signature.match(/.{2}/g)!.map(b => parseInt(b, 16)));

  try {
    const valid = ed.verify(sigBytes, msgBytes, publicKey);
    return valid ? { valid: true, did } : { valid: false, error: 'Invalid signature' };
  } catch {
    return { valid: false, error: 'Signature verification failed' };
  }
}

/** Try to get viewer DID from session cookie (non-blocking) */
async function getViewerDid(request: NextRequest): Promise<string | null> {
  try {
    const session = await getSessionFromCookies(request.headers.get('cookie'));
    return session?.did ?? null;
  } catch { return null; }
}

/** Check if viewerDid is connected to targetDid */
async function checkConnected(viewerDid: string, targetDid: string): Promise<boolean> {
  try {
    const [conn] = await db
      .select({ id: connections.didA })
      .from(connections)
      .where(
        and(
          or(
            and(eq(connections.didA, viewerDid), eq(connections.didB, targetDid)),
            and(eq(connections.didA, targetDid), eq(connections.didB, viewerDid))
          ),
          isNull(connections.disconnectedAt)
        )
      )
      .limit(1);
    return !!conn;
  } catch { return false; }
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

  try {
    // Look up by DID or handle
    const profile = await db.query.profiles.findFirst({
      where: (profiles, { eq, or }) =>
        or(eq(profiles.did, id), eq(profiles.handle, id)),
    });

    if (!profile) {
      return NextResponse.json({ error: 'Profile not found' }, { status: 404, headers: cors });
    }

    // Gate contact info: only visible to self or connections
    const result: Record<string, any> = { ...profile };
    let viewerDid: string | null = null;
    if (profile.contactEmail || profile.phone) {
      viewerDid = await getViewerDid(request);
      const isSelf = viewerDid === profile.did;
      const connected = viewerDid && !isSelf ? await checkConnected(viewerDid, profile.did) : false;
      if (!isSelf && !connected) {
        delete result.contactEmail;
        delete result.phone;
      }
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

      if (!viewerDid) viewerDid = await getViewerDid(request);
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

    if (!existing) {
      return NextResponse.json({ error: 'Profile not found' }, { status: 404, headers: cors });
    }

    // Check ownership
    if (existing.did !== identity.id) {
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
    const { displayName, avatar, avatarAssetId, bio, email, phone, visibility, feature_toggles } = body;

    // Build update object
    const updates: Record<string, any> = {
      updatedAt: new Date(),
    };

    if (displayName !== undefined) updates.displayName = displayName;
    if (avatar !== undefined) updates.avatar = avatar;
    if (avatarAssetId !== undefined) updates.avatarAssetId = avatarAssetId;
    if (bio !== undefined) updates.bio = bio;
    if (email !== undefined) updates.contactEmail = email || null;
    if (phone !== undefined) updates.phone = phone || null;
    if (feature_toggles !== undefined) {
      // Merge incoming feature_toggles over existing ones
      updates.featureToggles = { ...(existing.featureToggles ?? {}), ...feature_toggles };
    }
    if (visibility !== undefined) {
      if (!['public', 'incognito'].includes(visibility)) {
        return NextResponse.json({ error: 'visibility must be public or incognito' }, { status: 400, headers: cors });
      }
      updates.visibility = visibility;
    }

    // Update profile
    const [updated] = await db
      .update(profiles)
      .set(updates)
      .where(eq(profiles.did, existing.did))
      .returning();

    events.emit({ action: 'profile.update', did: identity.id, payload: { profileDid: existing.did } });

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
