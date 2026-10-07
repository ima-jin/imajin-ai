/**
 * PATCH /api/admin/registry/apps/:appId (#2638 / #2641)
 *
 * The operator's approval of which event types a registered app may emit via
 * `POST /api/events`. Body: `{ emittableEvents: string[] }` — the FULL approved
 * list (replace, not merge), so what the operator sends is exactly what the app
 * may emit afterwards; `[]` withdraws every approval. Default for every app is
 * the empty list.
 *
 * Admin-scoped like every other registry mutation, and signed into the audit
 * trail with a `registry.app.emittable-events.updated` attestation carrying the
 * before/after lists. What an approved event type can trigger is bounded
 * separately and is not widened by this route: an app-emitted event only ever
 * runs notify + audit-log reactors.
 */
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, registryApps } from '@/src/db';
import { emitAttestation } from '@imajin/auth';
import { requireAdminSession } from '@/src/lib/kernel/app-registry-admin';
import { readEmittableEvents, validateEmittableEvents } from '@/src/lib/kernel/emittable-events';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

export async function PATCH(request: NextRequest, props: { params: Promise<{ appId: string }> }) {
  const authResult = await requireAdminSession();
  if ('error' in authResult) return authResult.error;
  const { session } = authResult;

  const { appId } = await props.params;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (body?.emittableEvents === undefined) {
    return NextResponse.json({ error: 'emittableEvents is required' }, { status: 400 });
  }
  const emittable = validateEmittableEvents(body.emittableEvents);
  if ('error' in emittable) {
    return NextResponse.json({ error: emittable.error }, { status: 400 });
  }

  const [existing] = await db
    .select({ id: registryApps.id, appDid: registryApps.appDid, emittableEvents: registryApps.emittableEvents })
    .from(registryApps)
    .where(eq(registryApps.id, appId))
    .limit(1);
  if (!existing) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const [updated] = await db
    .update(registryApps)
    .set({ emittableEvents: emittable.ok, updatedAt: new Date() })
    .where(eq(registryApps.id, appId))
    .returning({ id: registryApps.id, appDid: registryApps.appDid, emittableEvents: registryApps.emittableEvents });

  emitAttestation({
    issuer_did: session.actingAs,
    subject_did: existing.appDid,
    type: 'registry.app.emittable-events.updated',
    context_id: appId,
    context_type: 'registry_app',
    payload: { appId, previous: readEmittableEvents(existing.emittableEvents), emittableEvents: emittable.ok },
  }).catch((err: unknown) => log.error({ err: String(err), appId }, 'registry.app.emittable-events.updated attestation failed'));

  return NextResponse.json({ ok: true, app: updated });
}
