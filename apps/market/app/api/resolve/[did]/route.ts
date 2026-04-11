import { NextRequest } from 'next/server';
import { createLogger } from '@imajin/logger';
const log = createLogger('market');
import { jsonResponse, errorResponse } from '@/lib/utils';

export const dynamic = 'force-dynamic';

const PROFILE_SERVICE_URL =
  process.env.PROFILE_SERVICE_URL || 'http://localhost:3005';

/**
 * GET /api/resolve/:did — Resolve DID to profile info (handle, displayName)
 * Server-side proxy to profile service so clients don't make cross-service calls.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: { did: string } }
) {
  const { did } = params;

  if (!did) {
    return errorResponse('did is required');
  }

  try {
    const res = await fetch(
      `${PROFILE_SERVICE_URL}/api/profile/${encodeURIComponent(did)}`
    );
    if (!res.ok) {
      return errorResponse('Identity not found', 404);
    }
    const profile = await res.json();
    return jsonResponse({
      did: profile.did,
      handle: profile.handle,
      displayName: profile.displayName,
    });
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to resolve DID');
    return errorResponse('Failed to resolve identity', 500);
  }
}
