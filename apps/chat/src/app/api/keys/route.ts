import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { ed25519 } from '@noble/curves/ed25519';
import { db, publicKeys, preKeys } from '@/db';
import { requireAuth } from '@/lib/auth';
import { jsonResponse, errorResponse, generateId } from '@/lib/utils';

/**
 * POST /api/keys - Upload/update public key bundle
 */
export async function POST(request: NextRequest) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { identity } = authResult;

  try {
    const body = await request.json();
    const { identityKey, signedPreKey, signature, oneTimePreKeys } = body;

    // Validate required fields
    if (!identityKey || !signedPreKey || !signature) {
      return errorResponse('identityKey, signedPreKey, and signature are required');
    }

    // Verify signature on signedPreKey using identityKey
    try {
      const identityKeyBytes = Buffer.from(identityKey, 'base64');
      const signedPreKeyBytes = Buffer.from(signedPreKey, 'base64');
      const signatureBytes = Buffer.from(signature, 'base64');
      const valid = ed25519.verify(signatureBytes, signedPreKeyBytes, identityKeyBytes);
      if (!valid) {
        return errorResponse('Invalid signedPreKey signature', 400);
      }
    } catch {
      return errorResponse('Invalid signedPreKey signature', 400);
    }

    // Upsert main key bundle
    const existing = await db.query.publicKeys.findFirst({
      where: eq(publicKeys.did, identity.id),
    });

    if (existing) {
      await db
        .update(publicKeys)
        .set({
          identityKey,
          signedPreKey,
          signature,
          updatedAt: new Date(),
        })
        .where(eq(publicKeys.did, identity.id));
    } else {
      await db.insert(publicKeys).values({
        did: identity.id,
        identityKey,
        signedPreKey,
        signature,
      });
    }

    // Add one-time pre-keys if provided
    if (oneTimePreKeys && Array.isArray(oneTimePreKeys)) {
      for (const key of oneTimePreKeys) {
        await db.insert(preKeys).values({
          id: generateId('pk'),
          did: identity.id,
          key,
        });
      }
    }

    return jsonResponse({ 
      success: true,
      preKeysAdded: oneTimePreKeys?.length || 0,
    });
  } catch (error) {
    console.error('Failed to upload keys:', error);
    return errorResponse('Failed to upload keys', 500);
  }
}

/**
 * GET /api/keys - Get your own keys (for verification)
 */
export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { identity } = authResult;

  try {
    const keyBundle = await db.query.publicKeys.findFirst({
      where: eq(publicKeys.did, identity.id),
    });

    if (!keyBundle) {
      return errorResponse('No keys uploaded', 404);
    }

    // Count unused pre-keys
    const unusedPreKeys = await db.query.preKeys.findMany({
      where: eq(preKeys.did, identity.id),
    });
    const unusedCount = unusedPreKeys.filter(k => !k.used).length;

    return jsonResponse({
      ...keyBundle,
      unusedPreKeyCount: unusedCount,
    });
  } catch (error) {
    console.error('Failed to get keys:', error);
    return errorResponse('Failed to get keys', 500);
  }
}
