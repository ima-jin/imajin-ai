/**
 * POST /api/admin/registry/apps/:appId/revoke (#1990)
 *
 * Operator-only Clear, called by /jin (#3031). Flips `status` to `revoked`
 * and records its signed receipt atomically — every enforcement point added by
 * #1990 (`resolveActiveAppByAudience`, `isAppDidActive`) re-checks this
 * column on every mint/verify call, so a revoked app's already-minted
 * scoped app-tokens stop verifying on their very next use, and it can no
 * longer mint new ones or complete an OAuth redirect.
 */
import { NextRequest, NextResponse } from 'next/server';
import { and, eq, ne } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db, registryApps, attestations } from '@/src/db';
import { requireAuth, canonicalize, crypto as authCrypto } from '@imajin/auth';
import { findRegistryApp } from '@/src/lib/kernel/app-registry-admin';
import { getOperatorDid, isOperatorIdentity } from '@/src/lib/notify/operator-approvals';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

export async function POST(request: NextRequest, props: { params: Promise<{ appId: string }> }) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }
  const operator = await getOperatorDid();
  if (!operator || !isOperatorIdentity(authResult.identity, operator)) {
    return NextResponse.json({ error: 'Node operator required' }, { status: 403 });
  }

  const { appId } = await props.params;

  const existing = await findRegistryApp(appId);
  if (!existing) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (existing.status === 'revoked') {
    return NextResponse.json({ ok: true, alreadyRevoked: true });
  }

  const privateKey = process.env.AUTH_PRIVATE_KEY;
  if (!privateKey) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 503 });
  }
  try {
    const result = await db.transaction(async tx => {
      const issuedAt = Date.now();
      const [claimed] = await tx.update(registryApps)
        .set({ status: 'revoked', revokedAt: new Date(issuedAt), updatedAt: new Date(issuedAt) })
        .where(and(eq(registryApps.id, appId), ne(registryApps.status, 'revoked')))
        .returning({ appDid: registryApps.appDid });
      if (!claimed) return { ok: true, alreadyRevoked: true };

      const payload = { appId };
      const signature = authCrypto.signSync(canonicalize({
        subject_did: claimed.appDid, type: 'registry.app.revoked',
        context_id: appId, context_type: 'registry_app', payload, issued_at: issuedAt,
      }), privateKey);
      const attestationId = `att_${nanoid(16)}`;
      // Commit the retained row's state and signed receipt together. A refresh
      // after POST can never race a fire-and-forget attestation write.
      await tx.insert(attestations).values({
        id: attestationId, issuerDid: operator, subjectDid: claimed.appDid,
        type: 'registry.app.revoked', contextId: appId, contextType: 'registry_app',
        payload, signature, issuedAt: new Date(issuedAt),
      });
      return { ok: true, attestationId };
    });
    return NextResponse.json(result);
  } catch {
    log.error({ appId }, 'Registry app revoke failed');
    return NextResponse.json({ error: 'Could not clear registered app' }, { status: 503 });
  }
}
