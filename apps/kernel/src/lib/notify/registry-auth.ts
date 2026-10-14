import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { requireInternalApiKey } from '../auth/require-internal-api-key';

/** Internal preference access is vault-only; sessions still own exactly one DID. */
export async function authorizePreferenceDid(
  request: NextRequest,
  did: string,
  headers: Record<string, string>,
): Promise<{ internal: boolean; error?: never } | { error: NextResponse; internal?: never }> {
  if (request.headers.has('authorization') && !await requireInternalApiKey(request)) {
    return { internal: true };
  }
  const auth = await requireAuth(request);
  if ('error' in auth) {
    return { error: NextResponse.json({ error: auth.error }, { status: auth.status, headers }) };
  }
  if (resolveActingDid(auth.identity) !== did) {
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403, headers }) };
  }
  return { internal: false };
}
