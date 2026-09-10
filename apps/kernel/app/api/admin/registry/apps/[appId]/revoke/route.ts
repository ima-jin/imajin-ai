/**
 * POST /api/admin/registry/apps/:appId/revoke (#1990)
 *
 * Admin-scoped counterpart to the owner-scoped `DELETE /api/registry/apps/:id`
 * soft-revoke. Flips `status` to `revoked` — every enforcement point added by
 * #1990 (`resolveActiveAppByAudience`, `isAppDidActive`) re-checks this
 * column on every mint/verify call, so a revoked app's already-minted
 * scoped app-tokens stop verifying on their very next use, and it can no
 * longer mint new ones or complete an OAuth redirect.
 */
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, registryApps } from '@/src/db';
import { emitAttestation } from '@imajin/auth';
import { requireAdminSession, findRegistryApp } from '@/src/lib/kernel/app-registry-admin';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

export async function POST(_request: NextRequest, props: { params: Promise<{ appId: string }> }) {
  const authResult = await requireAdminSession();
  if ('error' in authResult) return authResult.error;
  const { session } = authResult;

  const { appId } = await props.params;

  const existing = await findRegistryApp(appId);
  if (!existing) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (existing.status === 'revoked') {
    return NextResponse.json({ ok: true, alreadyRevoked: true });
  }

  await db
    .update(registryApps)
    .set({ status: 'revoked', revokedAt: new Date(), updatedAt: new Date() })
    .where(eq(registryApps.id, appId));

  emitAttestation({
    issuer_did: session.actingAs,
    subject_did: existing.appDid,
    type: 'registry.app.revoked',
    context_id: appId,
    context_type: 'registry_app',
    payload: { appId },
  }).catch((err: unknown) => log.error({ err: String(err), appId }, 'registry.app.revoked attestation failed'));

  return NextResponse.json({ ok: true });
}
