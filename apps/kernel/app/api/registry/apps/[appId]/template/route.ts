import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db, registryApps } from '@/src/db';
import { resolveAppServiceCaller } from '@/src/lib/auth/app-service-caller';
import { validateTemplateSyncReport } from '@/src/lib/apps/template-lineage';

/** Report a merged template sync as the app itself; no person/session or cross-app authority. */
export async function PATCH(request: NextRequest, props: { params: Promise<{ appId: string }> }) {
  const header = request.headers.get('authorization');
  const caller = header?.startsWith('Bearer ')
    ? await resolveAppServiceCaller(header.slice('Bearer '.length))
    : null;
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { appId } = await props.params;
  const [app] = await db.select({ appDid: registryApps.appDid, template: registryApps.template, joined: registryApps.joined })
    .from(registryApps).where(eq(registryApps.id, appId)).limit(1);
  if (!app) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (app.appDid !== caller.appDid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  if (!app.template || !app.joined) return NextResponse.json({ error: 'App has not joined a template' }, { status: 409 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Expected a JSON object' }, { status: 400 });
  }
  const report = validateTemplateSyncReport(body as Record<string, unknown>);
  if ('error' in report) return NextResponse.json({ error: report.error }, { status: 400 });
  const [updated] = await db.update(registryApps)
    .set({ ...report.ok, updatedAt: new Date() })
    .where(and(
      eq(registryApps.id, appId),
      eq(registryApps.appDid, caller.appDid),
      eq(registryApps.status, 'active'),
      eq(registryApps.joined, true),
      eq(registryApps.template, app.template),
    ))
    .returning({ appId: registryApps.id, templateRef: registryApps.templateRef, templateSyncedAt: registryApps.templateSyncedAt });
  if (!updated) return NextResponse.json({ error: 'App status or template lineage changed; retry the report' }, { status: 409 });
  return NextResponse.json(updated);
}
