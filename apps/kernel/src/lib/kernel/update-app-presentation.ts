import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, registryApps } from '@/src/db';
import { emitAttestation } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { validateRegistryPresentation } from '@/src/lib/apps/registry-presentation';

const log = createLogger('kernel');
const FIELDS = ['profileWidget', 'entryUrl', 'icon', 'placements', 'requiredScope'] as const;

export function hasPresentationUpdate(body: Record<string, unknown>): boolean {
  return FIELDS.some((field) => Object.hasOwn(body, field));
}

/** Presentation only; cannot mutate a person's membership or authorization. */
export async function updateAppPresentation(appId: string, body: Record<string, unknown>, actingAs: string) {
  if (Object.hasOwn(body, 'emittableEvents')) {
    return NextResponse.json({ error: 'Update presentation and emittableEvents separately' }, { status: 400 });
  }
  const [existing] = await db.select().from(registryApps).where(eq(registryApps.id, appId)).limit(1);
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const changes = Object.fromEntries(FIELDS.filter((field) => Object.hasOwn(body, field)).map((field) => [field, body[field]]));
  const validated = validateRegistryPresentation({ ...existing, ...changes });
  if ('error' in validated) return NextResponse.json({ error: validated.error }, { status: 400 });
  const [updated] = await db.update(registryApps).set({ ...validated.ok, updatedAt: new Date() })
    .where(eq(registryApps.id, appId)).returning();
  emitAttestation({
    issuer_did: actingAs, subject_did: existing.appDid,
    type: 'registry.app.presentation.updated', context_id: appId, context_type: 'registry_app',
    payload: { appId, ...validated.ok },
  }).catch((err: unknown) => log.error({ err: String(err), appId }, 'registry.app.presentation.updated attestation failed'));
  return NextResponse.json({ ok: true, app: updated });
}
