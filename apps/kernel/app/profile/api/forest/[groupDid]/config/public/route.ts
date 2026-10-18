import { NextRequest, NextResponse } from 'next/server';
import { db, forestConfig, registryApps } from '@/src/db';
import { and, eq } from 'drizzle-orm';
import { SERVICES } from '@imajin/config';

const PUBLIC_KERNEL_SERVICES = SERVICES
  .filter((service) => service.category === 'kernel' && service.visibility !== 'internal')
  .map((service) => service.name);

/**
 * GET /api/forest/[groupDid]/config/public
 * Public forest config — returns enabled services, landing page, and the
 * group's .fair scope fee. No auth required. Only active public registry apps
 * and kernel service names may be disclosed here. An empty list never grants
 * app membership or changes public web serving. `scopeFeeBps` lets coffee/learn/market
 * build `.fair` manifests without a raw `profile.forest_config` read
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

  if (!config) {
    return NextResponse.json({ enabledServices: [], landingService: null, scopeFeeBps: null });
  }
  const apps = await db.select({ slug: registryApps.slug }).from(registryApps).where(and(
    eq(registryApps.status, 'active'),
    eq(registryApps.visibility, 'public'),
  ));
  const publicNames = new Set([...PUBLIC_KERNEL_SERVICES, ...apps.map((app) => app.slug)]);
  const enabledServices = config.enabledServices.filter((name) => publicNames.has(name));
  const landingService = config.landingService && enabledServices.includes(config.landingService)
    ? config.landingService : null;
  return NextResponse.json({ enabledServices, landingService, scopeFeeBps: config.scopeFeeBps });
}
