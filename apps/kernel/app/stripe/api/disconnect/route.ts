/**
 * POST + OPTIONS /stripe/api/disconnect (#1785)
 *
 * Disconnect for the Stripe BYO-restricted-key connector — the #1776
 * disconnect-approval pattern: deprovision the webhook endpoint with the
 * owner's own key FIRST, then revoke the sealed restricted key's delegation
 * grant (crypto-erasing it, #1720 semantics) and every active
 * `channel_links` row for this connector + DID. The sealed key itself is not
 * deleted — the owner can restore access by re-pasting the same key, which
 * will self-provision a fresh webhook endpoint.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createLogger } from '@imajin/logger';
import { publish } from '@imajin/bus';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { resolveConnectorOwnerDid } from '@/src/lib/kernel/connector-owner-did';
import { disconnectAndDeprovision } from '@/src/lib/stripe/connector';

const log = createLogger('kernel');

export async function OPTIONS(request: NextRequest): Promise<NextResponse> {
  return corsOptions(request) as NextResponse;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const cors = corsHeaders(request);

  const auth = await resolveConnectorOwnerDid(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status, headers: cors });
  }
  const { ownerDid } = auth;

  let revoked: boolean;
  let deprovisioned: boolean;
  try {
    ({ revoked, deprovisioned } = await disconnectAndDeprovision(ownerDid));
    log.info({ ownerDid, revoked, deprovisioned }, 'Stripe disconnect attempted');
  } catch (err) {
    log.error({ err: String(err), ownerDid }, 'Stripe disconnect failed');
    return NextResponse.json(
      { error: 'Failed to disconnect Stripe', detail: String(err) },
      { status: 500, headers: cors },
    );
  }

  // Audit trail (#1490 shape) — non-fatal, the revoke already happened.
  publish('connector.disconnected', {
    issuer: ownerDid,
    subject: ownerDid,
    scope: 'stripe',
    payload: { ownerDid, connector: 'stripe', context_id: ownerDid, context_type: 'stripe' },
  }).catch((err: unknown) => {
    log.error({ err: String(err), ownerDid }, 'Stripe disconnect: bus publish failed (non-fatal)');
  });

  return NextResponse.json({ connected: false, revoked, deprovisioned }, { headers: cors });
}
