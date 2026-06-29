/**
 * POST /api/auth/integrations/revoke
 *
 * Single user-initiated revoke entry point (#1171). Body is a GrantRef:
 *   { kind: "attestation", attestationId }  — OAuth / app-keypair grant
 *   { kind: "channel-link", id }            — bot/messenger link
 *
 * Delegates to revokeGrant(), which revokes the per-user grant (+ OAuth
 * refresh-token chain) and NEVER touches the shared registry.apps adapter row.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@imajin/auth';
import { withLogger } from '@imajin/logger';
import { revokeGrant, type GrantRef } from '@/src/lib/auth/revoke-grant';

function parseGrantRef(body: Record<string, unknown>): GrantRef | null {
  if (body.kind === 'attestation' && typeof body.attestationId === 'string') {
    return { kind: 'attestation', attestationId: body.attestationId };
  }
  if (body.kind === 'channel-link' && typeof body.id === 'string') {
    return { kind: 'channel-link', id: body.id };
  }
  return null;
}

export const POST = withLogger('kernel', async (request: NextRequest) => {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const ref = parseGrantRef(body);
  if (!ref) {
    return NextResponse.json(
      { error: 'Provide { kind: "attestation", attestationId } or { kind: "channel-link", id }' },
      { status: 400 },
    );
  }

  const result = await revokeGrant(ref, authResult.identity.id);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true });
});
