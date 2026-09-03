/**
 * GET + PUT + DELETE /local/api/settings (#1957)
 *
 * The owner's local inference `baseUrl` — the `ConnectorSettingsUi` mechanism
 * the Warp connector's `/warp/api/environment` already uses (single
 * non-secret text field, round-tripped to the browser for editing). This is
 * the one setting the connector actually needs: no sealed key is required to
 * use it (see `../../../src/lib/local/connector.ts`'s header).
 *
 * `PUT` is where the egress-safety validation happens (scheme, DNS
 * resolution, deny-list) — `saveBaseUrl` throws `LocalBaseUrlRejectedError`
 * for a denied URL, reported here as 400 with the (safe-to-show) denial
 * reason. On success the resolved address is pinned (`local-pinned-ip`) for
 * every later call to reuse without re-resolving — see `saveBaseUrl`'s own
 * doc comment for the full "host pin after first save" contract.
 *
 * `GET`/`DELETE` never re-validate — reading or clearing a stored value
 * cannot itself constitute new egress.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createLogger } from '@imajin/logger';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { resolveConnectorOwnerDid } from '@/src/lib/kernel/connector-owner-did';
import { saveBaseUrl, readBaseUrl, clearBaseUrl, LocalBaseUrlRejectedError } from '@/src/lib/local/connector';

const log = createLogger('kernel');

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

/** Returns `{ baseUrl: string }` — empty string when unset, matching the generic settings-section contract. */
export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);
  const auth = await resolveConnectorOwnerDid(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status, headers: cors });
  }

  const stored = await readBaseUrl(auth.ownerDid);
  return NextResponse.json({ baseUrl: stored?.baseUrl ?? '' }, { headers: cors });
}

/** Sets `baseUrl` from `{ baseUrl: string }`, validating and pinning it first. */
export async function PUT(request: NextRequest) {
  const cors = corsHeaders(request);
  const auth = await resolveConnectorOwnerDid(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status, headers: cors });
  }

  let body: { baseUrl?: unknown };
  try {
    body = (await request.json()) as { baseUrl?: unknown };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: cors });
  }

  const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '';
  if (!baseUrl) {
    return NextResponse.json({ error: 'baseUrl must be a non-empty string' }, { status: 400, headers: cors });
  }

  try {
    const saved = await saveBaseUrl(auth.ownerDid, baseUrl);
    return NextResponse.json({ baseUrl: saved.baseUrl }, { headers: cors });
  } catch (err) {
    if (err instanceof LocalBaseUrlRejectedError) {
      log.warn({ ownerDid: auth.ownerDid, reason: err.reason }, 'local connector: baseUrl rejected by egress guard');
      return NextResponse.json({ error: err.message, reason: err.reason }, { status: 400, headers: cors });
    }
    log.error({ err: String(err), ownerDid: auth.ownerDid }, 'local connector: failed to save baseUrl');
    return NextResponse.json({ error: 'Failed to save baseUrl' }, { status: 500, headers: cors });
  }
}

/** Clears the stored `baseUrl` (and its pinned address). */
export async function DELETE(request: NextRequest) {
  const cors = corsHeaders(request);
  const auth = await resolveConnectorOwnerDid(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status, headers: cors });
  }

  try {
    await clearBaseUrl(auth.ownerDid);
  } catch (err) {
    log.error({ err: String(err), ownerDid: auth.ownerDid }, 'local connector: failed to clear baseUrl');
    return NextResponse.json({ error: 'Failed to clear baseUrl' }, { status: 500, headers: cors });
  }

  return NextResponse.json({ baseUrl: '' }, { headers: cors });
}
