/**
 * GET /profile/api/profile/:id/etransfer-email
 *
 * Owner-only read of the business profile's e-Transfer receiving email
 * (#2665). The public `GET /profile/api/profile/:id` withholds this field
 * from everyone but the profile's own DID, and cannot tell an acting delegate
 * (`x-acting-for` / `x-acting-as`) from a stranger — so the settings UI reads
 * it here, where the caller's effective DID (`resolveActingDid`) is checked
 * against the profile. Writes go through `PUT /profile/api/profile/:id`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/src/db';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

interface RouteParams {
  params: Promise<{ id: string }>;
}

export function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const cors = corsHeaders(request);

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }
  const effectiveDid = resolveActingDid(authResult.identity);

  try {
    const profile = await db.query.profiles.findFirst({
      where: (p, { eq, or }) => or(eq(p.did, id), eq(p.handle, id)),
    });
    if (!profile) {
      return NextResponse.json({ error: 'Profile not found' }, { status: 404, headers: cors });
    }
    if (profile.did !== authResult.identity.id && profile.did !== effectiveDid) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403, headers: cors });
    }
    return NextResponse.json({ etransferEmail: profile.etransferEmail ?? null }, { headers: cors });
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to fetch e-Transfer email');
    return NextResponse.json({ error: 'Failed to fetch e-Transfer email' }, { status: 500, headers: cors });
  }
}
