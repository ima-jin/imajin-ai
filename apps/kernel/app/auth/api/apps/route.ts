/**
 * GET /auth/api/apps?for=<did>&placement=<launcher|home|auth-submenu> (#2425)
 *
 * Registry ∩ enabled-for-this-identity ∩ scope — the one read every
 * authenticated nav surface (the `/auth` hub tab bar, its dynamic
 * `/auth/[app]` route) can call instead of hand-rolling a literal app list.
 * See `src/lib/kernel/app-nav.ts` for the resolution logic.
 *
 * Auth: `requireAuth` + `resolveActingDid` — same "owner, or a registered
 * agent already delegated via `actingFor`" self-only rule as
 * `usage/api/summary/route.ts` and `usage/api/rollups/route.ts`. `for`
 * defaults to the caller's own effective DID; supplying a different one is
 * Forbidden (this endpoint is for the authenticated hub, not a public
 * profile read — see `ServiceLinks.tsx`, which stays on its own
 * server-computed, unauthenticated path for anonymous profile viewers).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { resolveNavAppsForIdentity, filterByPlacement, APP_PLACEMENTS, type AppPlacement } from '@/src/lib/kernel/app-nav';

function isAppPlacement(value: string): value is AppPlacement {
  return (APP_PLACEMENTS as readonly string[]).includes(value);
}

export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }
  const effectiveDid = resolveActingDid(authResult.identity);

  const { searchParams } = new URL(request.url);
  const did = searchParams.get('for') ?? effectiveDid;
  if (did !== effectiveDid) {
    return NextResponse.json({ error: 'Forbidden - can only list apps for your own identity' }, { status: 403 });
  }

  const placementParam = searchParams.get('placement');
  let placement: AppPlacement | undefined;
  if (placementParam !== null) {
    if (!isAppPlacement(placementParam)) {
      return NextResponse.json(
        { error: `placement must be one of ${APP_PLACEMENTS.join(', ')}` },
        { status: 400 },
      );
    }
    placement = placementParam;
  }

  const apps = await resolveNavAppsForIdentity(did);
  const result = placement ? filterByPlacement(apps, placement) : apps;

  return NextResponse.json({ apps: result }, { headers: { 'Cache-Control': 'private, max-age=30' } });
}
