/**
 * POST /api/admin/registry/apps/:appId/rotate (#1990)
 *
 * Mints a fresh Ed25519 keypair and replaces the app's stored `public_key`.
 * `app_did` is NOT re-derived from the new key: every route that verifies a
 * proof-of-possession signature (`/auth/api/apps/token`,
 * `.../apps/token/service`) looks up `registry.apps.public_key` BY `app_did`,
 * never the other way around, so rotating the key in place is safe and does
 * not orphan any attestation, actor identity, or channel_links row that
 * already references the app's `app_did`.
 *
 * The new private key is returned exactly once and never stored — same
 * contract as the self-service server-generated-keypair path
 * (`POST /api/registry/apps`).
 */
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, registryApps } from '@/src/db';
import { requireAdmin, generateKeypair, emitAttestation } from '@imajin/auth';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

export async function POST(_request: NextRequest, props: { params: Promise<{ appId: string }> }) {
  const session = await requireAdmin();
  if (!session?.actingAs) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { appId } = await props.params;

  const [existing] = await db
    .select({ id: registryApps.id, appDid: registryApps.appDid, status: registryApps.status })
    .from(registryApps)
    .where(eq(registryApps.id, appId))
    .limit(1);

  if (!existing) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (existing.status !== 'active') {
    return NextResponse.json({ error: 'Cannot rotate a revoked app — register a new one instead' }, { status: 409 });
  }

  const { privateKey, publicKey } = generateKeypair();

  const [updated] = await db
    .update(registryApps)
    .set({ publicKey, updatedAt: new Date() })
    .where(eq(registryApps.id, appId))
    .returning();

  emitAttestation({
    issuer_did: session.actingAs,
    subject_did: existing.appDid,
    type: 'registry.app.rotated',
    context_id: appId,
    context_type: 'registry_app',
    payload: { appId },
  }).catch((err: unknown) => log.error({ err: String(err), appId }, 'registry.app.rotated attestation failed'));

  return NextResponse.json({ ...updated, keypair: { privateKey, publicKey } });
}
