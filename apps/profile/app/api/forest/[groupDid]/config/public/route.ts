import { NextRequest, NextResponse } from 'next/server';
import { db, forestConfig } from '@/src/db';
import { eq } from 'drizzle-orm';

/**
 * GET /api/forest/[groupDid]/config/public
 * Public forest config — returns enabled services and landing page.
 * No auth required. Empty enabledServices means show all (unconfigured).
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
    })
    .from(forestConfig)
    .where(eq(forestConfig.groupDid, groupDid))
    .limit(1);

  return NextResponse.json(config ?? { enabledServices: [], landingService: null });
}
