import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, publicKeys, preKeys } from '@/db';
import { jsonResponse, errorResponse, isValidDid } from '@/lib/utils';

/**
 * GET /api/keys/:did - Get public keys for E2EE
 * Public endpoint - no auth required
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ did: string }> }
) {
  const { did } = await params;

  if (!isValidDid(did)) {
    return errorResponse('Invalid DID format');
  }

  try {
    // Get main public key bundle
    const keyBundle = await db.query.publicKeys.findFirst({
      where: eq(publicKeys.did, did),
    });

    if (!keyBundle) {
      return errorResponse('No keys found for this DID', 404);
    }

    // Get an unused one-time pre-key (if available)
    const oneTimeKey = await db.query.preKeys.findFirst({
      where: eq(preKeys.did, did),
      // TODO: Filter unused keys - Drizzle syntax for this
    });

    // Mark the pre-key as used if we found one
    if (oneTimeKey && !oneTimeKey.used) {
      await db
        .update(preKeys)
        .set({ used: true })
        .where(eq(preKeys.id, oneTimeKey.id));
    }

    return jsonResponse({
      did: keyBundle.did,
      identityKey: keyBundle.identityKey,
      signedPreKey: keyBundle.signedPreKey,
      signature: keyBundle.signature,
      oneTimePreKey: oneTimeKey?.key || null,
    });
  } catch (error) {
    console.error('Failed to get keys:', error);
    return errorResponse('Failed to get keys', 500);
  }
}
