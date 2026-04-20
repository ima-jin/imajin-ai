/**
 * GET /api/auth/apps
 *
 * Returns all apps the authenticated user has authorized, with scopes and dates.
 * Active and revoked authorizations are both returned (revoked have revokedAt set).
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, attestations, registryApps } from '@/src/db';
import { eq, and, inArray } from 'drizzle-orm';
import { requireAuth } from '@imajin/auth';
import { withLogger } from '@imajin/logger';

export const GET = withLogger('kernel', async (request: NextRequest) => {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { identity } = authResult;

  // All app.authorized attestations issued by this user
  const authorizations = await db
    .select({
      attestationId: attestations.id,
      appDid: attestations.subjectDid,
      payload: attestations.payload,
      issuedAt: attestations.issuedAt,
      revokedAt: attestations.revokedAt,
    })
    .from(attestations)
    .where(
      and(
        eq(attestations.issuerDid, identity.id),
        eq(attestations.type, 'app.authorized'),
      )
    );

  if (authorizations.length === 0) {
    return NextResponse.json({ apps: [] });
  }

  // Look up app metadata for each unique appDid
  const appDids = [...new Set(authorizations.map(a => a.appDid))];
  const appRecords = await db
    .select({
      appDid: registryApps.appDid,
      id: registryApps.id,
      name: registryApps.name,
      description: registryApps.description,
      homepageUrl: registryApps.homepageUrl,
      logoUrl: registryApps.logoUrl,
      status: registryApps.status,
    })
    .from(registryApps)
    .where(inArray(registryApps.appDid, appDids));

  const appByDid = new Map(appRecords.map(a => [a.appDid, a]));

  const apps = authorizations.map(auth => {
    const app = appByDid.get(auth.appDid);
    const payload = auth.payload as { scopes?: string[] } | null;
    return {
      attestationId: auth.attestationId,
      appDid: auth.appDid,
      appId: app?.id ?? null,
      appName: app?.name ?? auth.appDid,
      appDescription: app?.description ?? null,
      appHomepageUrl: app?.homepageUrl ?? null,
      appLogoUrl: app?.logoUrl ?? null,
      appStatus: app?.status ?? 'unknown',
      scopes: payload?.scopes ?? [],
      authorizedAt: auth.issuedAt,
      revokedAt: auth.revokedAt,
    };
  });

  return NextResponse.json({ apps });
});
