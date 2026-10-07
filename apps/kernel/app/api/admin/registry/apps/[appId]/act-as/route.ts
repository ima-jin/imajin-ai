/**
 * POST /api/admin/registry/apps/:appId/act-as  (#2639 / #2644)
 *
 * Operator approval, per app, for scoped app tokens to carry an act-as (group
 * DID) claim. Body: `{ allowed: boolean }`. Off by default for every app.
 *
 * Admin-only, like `dependsOn` (an operator path, never self-service): approving
 * lets `POST /auth/api/tokens/app` mint tokens for this app that act as a group
 * the caller controls. Revoking (`allowed: false`) takes effect on the very next
 * verify — `POST /auth/api/tokens/app/verify` refuses any act-as token whose app
 * is no longer approved, the same re-check the registry applies to revocation.
 * Signs a `registry.app.act_as.updated` attestation.
 */
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, registryApps } from '@/src/db';
import { emitAttestation } from '@imajin/auth';
import { requireAdminSession, findRegistryApp } from '@/src/lib/kernel/app-registry-admin';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

export async function POST(request: NextRequest, props: { params: Promise<{ appId: string }> }) {
  const authResult = await requireAdminSession();
  if ('error' in authResult) return authResult.error;
  const { session } = authResult;

  const { appId } = await props.params;

  let body: { allowed?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (typeof body?.allowed !== 'boolean') {
    return NextResponse.json({ error: 'allowed must be a boolean' }, { status: 400 });
  }
  const allowed = body.allowed;

  const existing = await findRegistryApp(appId);
  if (!existing) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  await db
    .update(registryApps)
    .set({ actAsAllowed: allowed, updatedAt: new Date() })
    .where(eq(registryApps.id, appId));

  emitAttestation({
    issuer_did: session.actingAs,
    subject_did: existing.appDid,
    type: 'registry.app.act_as.updated',
    context_id: appId,
    context_type: 'registry_app',
    payload: { appId, actAsAllowed: allowed },
  }).catch((err: unknown) => log.error({ err: String(err), appId }, 'registry.app.act_as.updated attestation failed'));

  return NextResponse.json({ ok: true, actAsAllowed: allowed });
}
