import { NextRequest, NextResponse } from 'next/server';
import { and, asc, eq } from 'drizzle-orm';
import { db, registryApps } from '@/src/db';
import { isRepositoryName } from '@/src/lib/apps/template-lineage';
import { authorizeTemplateReader } from '@/src/lib/apps/template-reader';

/** Complete, stable cascade inventory — never the public directory's paginated subset. */
export async function GET(request: NextRequest) {
  const denied = await authorizeTemplateReader(request);
  if (denied) return NextResponse.json({ error: denied === 401 ? 'Unauthorized' : 'Forbidden' }, { status: denied });
  const template = new URL(request.url).searchParams.get('template');
  if (!isRepositoryName(template)) {
    return NextResponse.json({ error: 'template must be an owner/name repository identifier' }, { status: 400 });
  }
  const apps = await db
    .select({
      appId: registryApps.id,
      sourceRepo: registryApps.sourceRepo,
      templateRef: registryApps.templateRef,
      joined: registryApps.joined,
    })
    .from(registryApps)
    .where(and(eq(registryApps.template, template), eq(registryApps.status, 'active')))
    .orderBy(asc(registryApps.id));
  return NextResponse.json(apps, { headers: { 'Cache-Control': 'no-store' } });
}
