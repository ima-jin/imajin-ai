import { NextRequest } from 'next/server';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { db, profiles } from '@/db';
import { requireAuth } from '@/lib/auth';
import { jsonResponse, errorResponse } from '@/lib/utils';
import { eq } from 'drizzle-orm';

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

const CONNECTIONS_SERVICE_URL = process.env.CONNECTIONS_SERVICE_URL;

/** Try to get viewer DID from session cookie (non-blocking) */
async function getViewerDid(request: NextRequest): Promise<string | null> {
  const authUrl = process.env.AUTH_SERVICE_URL;
  if (!authUrl) return null;
  const cookie = request.headers.get('cookie') || '';
  const match = cookie.match(/imajin_session=([^;]+)/);
  if (!match) return null;
  try {
    const res = await fetch(`${authUrl}/api/session`, {
      headers: { Cookie: `imajin_session=${match[1]}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.did || data.identity?.did || null;
  } catch { return null; }
}

/** Check if viewer is connected to target */
async function checkConnected(viewerCookie: string, targetDid: string): Promise<boolean> {
  if (!CONNECTIONS_SERVICE_URL) return false;
  try {
    const res = await fetch(`${CONNECTIONS_SERVICE_URL}/api/connections`, {
      headers: { Cookie: viewerCookie },
    });
    if (!res.ok) return false;
    const data = await res.json();
    return (data.connections || []).some((c: any) => c.did === targetDid);
  } catch { return false; }
}

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/profile/:id - Get profile by DID or handle
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { id } = await params;

  try {
    // Look up by DID or handle
    const profile = await db.query.profiles.findFirst({
      where: (profiles, { eq, or }) => 
        or(eq(profiles.did, id), eq(profiles.handle, id)),
    });

    if (!profile) {
      return errorResponse('Profile not found', 404);
    }

    // Gate contact info: only visible to self or connections
    const result: Record<string, any> = { ...profile };
    if (profile.email || profile.phone) {
      const viewerDid = await getViewerDid(request);
      const isSelf = viewerDid === profile.did;
      const cookie = request.headers.get('cookie') || '';
      const connected = viewerDid && !isSelf ? await checkConnected(cookie, profile.did) : false;
      if (!isSelf && !connected) {
        delete result.email;
        delete result.phone;
      }
    }

    return jsonResponse(result);
  } catch (error) {
    console.error('Failed to fetch profile:', error);
    return errorResponse('Failed to fetch profile', 500);
  }
}

/**
 * PUT /api/profile/:id - Update profile (owner only)
 */
export async function PUT(request: NextRequest, { params }: RouteParams) {
  const { id } = await params;

  // Require authentication
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { identity } = authResult;

  try {
    // Fetch existing profile
    const existing = await db.query.profiles.findFirst({
      where: (profiles, { eq, or }) => 
        or(eq(profiles.did, id), eq(profiles.handle, id)),
    });

    if (!existing) {
      return errorResponse('Profile not found', 404);
    }

    // Check ownership
    if (existing.did !== identity.id) {
      return errorResponse('Not authorized to update this profile', 403);
    }

    // Clone the request body for signature verification
    const bodyText = await request.text();

    // Verify Ed25519 signed request headers if present
    const sigResult = await verifySignedRequest(request, bodyText);
    if (request.headers.get('x-signature')) {
      // Signature headers are present — enforce verification
      if (!sigResult.valid) {
        return errorResponse(`Signature verification failed: ${sigResult.error}`, 401);
      }
      // Ensure the signing DID matches the authenticated identity
      if (sigResult.did !== identity.id) {
        return errorResponse('Signature DID does not match authenticated identity', 403);
      }
    }

    const body = JSON.parse(bodyText);
    const { displayName, displayType, avatar, bio, email, phone, metadata } = body;

    // Build update object
    const updates: Record<string, any> = {
      updatedAt: new Date(),
    };

    if (displayName !== undefined) updates.displayName = displayName;
    if (displayType !== undefined) {
      if (!['human', 'agent', 'presence'].includes(displayType)) {
        return errorResponse('displayType must be human, agent, or presence');
      }
      updates.displayType = displayType;
    }
    if (avatar !== undefined) updates.avatar = avatar;
    if (bio !== undefined) updates.bio = bio;
    if (email !== undefined) updates.email = email || null;
    if (phone !== undefined) updates.phone = phone || null;
    if (metadata !== undefined) updates.metadata = metadata;

    // Update profile
    const [updated] = await db
      .update(profiles)
      .set(updates)
      .where(eq(profiles.did, existing.did))
      .returning();

    return jsonResponse(updated);
  } catch (error) {
    console.error('Failed to update profile:', error);
    return errorResponse('Failed to update profile', 500);
  }
}

/**
 * DELETE /api/profile/:id - Delete profile (owner only)
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const { id } = await params;

  // Require authentication
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { identity } = authResult;

  try {
    // Fetch existing profile
    const existing = await db.query.profiles.findFirst({
      where: (profiles, { eq, or }) => 
        or(eq(profiles.did, id), eq(profiles.handle, id)),
    });

    if (!existing) {
      return errorResponse('Profile not found', 404);
    }

    // Check ownership
    if (existing.did !== identity.id) {
      return errorResponse('Not authorized to delete this profile', 403);
    }

    // Delete profile
    await db.delete(profiles).where(eq(profiles.did, existing.did));

    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error('Failed to delete profile:', error);
    return errorResponse('Failed to delete profile', 500);
  }
}
