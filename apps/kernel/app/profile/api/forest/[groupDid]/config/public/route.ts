import { NextRequest, NextResponse } from 'next/server';
import { db, forestConfig } from '@/src/db';
import { eq } from 'drizzle-orm';

/**
 * GET /api/forest/[groupDid]/config/public
 * Public forest config — returns enabled services, landing page, and the
 * group's .fair scope fee. No auth required. Empty enabledServices means
 * show all (unconfigured). `scopeFeeBps` is included so coffee/learn/market
 * can build `.fair` manifests without a raw `profile.forest_config` read
 * (#2001) — it's the same value a member would see on the group's public
 * page, not sensitive.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ groupDid: string }> }
) {
  const { groupDid } = await params;

  const [config] = await db
    .select({
      enabledServices: forestConfig.enabledServices,
      landingService: forestConfig.landingService,
      scopeFeeBps: forestConfig.scopeFeeBps,
    })
    .from(forestConfig)
    .where(eq(forestConfig.groupDid, groupDid))
    .limit(1);

  return NextResponse.json(config ?? { enabledServices: [], landingService: null, scopeFeeBps: null });
}
