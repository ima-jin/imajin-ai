import type { NextRequest } from 'next/server';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { createDisconnectHandler } from '@/src/lib/kernel/connector-oauth-routes';
import { GOOGLE_CONNECTOR_DID, revokeAtGoogle } from '@/src/lib/google/connector';

const log = createLogger('kernel');

const sharedDisconnect = createDisconnectHandler({
  vaultPrefixes: ['google-config', 'google-oauth'],
  channel: 'google',
  connectorDid: GOOGLE_CONNECTOR_DID,
  connectorName: 'google',
});

/**
 * POST /google/api/disconnect — revoke both directions (#2144).
 *
 * 1. Revoke the sealed grant at Google's own revoke endpoint (best-effort,
 *    non-fatal — see `revokeAtGoogle`'s doc comment).
 * 2. Delegate to the shared handler: purge sealed vault fields, revoke the
 *    active `channel_links` row, publish `connector.disconnected`.
 *
 * Order matters: the provider-side revoke needs the still-sealed refresh
 * token, so it must run BEFORE the shared handler tombstones it.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if ('error' in auth) {
    // Let the shared handler produce the exact same 401 shape — no need to
    // duplicate its response construction here.
    return sharedDisconnect(request);
  }
  const ownerDid = resolveActingDid(auth.identity);

  try {
    await revokeAtGoogle(ownerDid);
  } catch (err) {
    // revokeAtGoogle itself is best-effort and should not throw, but this is
    // one more layer of "the owner's own revoke must never be blocked".
    log.warn({ err: String(err), ownerDid }, 'google disconnect: revokeAtGoogle threw unexpectedly (non-fatal)');
  }

  return sharedDisconnect(request);
}
