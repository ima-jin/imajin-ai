/**
 * GET + POST /stripe/api/token (#1785)
 *
 * Credential ingestion for the Stripe BYO-restricted-key connector. Unlike
 * the generic `createConnectorTokenRoutes` factory every other token-paste
 * connector uses, POST here does more than seal a value: pasting the
 * restricted key also self-provisions a Stripe webhook endpoint using that
 * key (see `connector.ts`), so this route is hand-written rather than a
 * thin factory wrapper.
 *
 *   GET  → `{ keySealed: boolean }`. An existence check, never the key.
 *   POST → seals `{ token }` (the restricted key) AND provisions the
 *          owner's webhook endpoint. `token` matches the generic
 *          `credentialBodyKey` contract the connector card already posts.
 *
 * Security invariants: the restricted key and the webhook signing secret are
 * never logged, never returned, never echoed.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createLogger } from '@imajin/logger';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { resolveConnectorOwnerDid } from '@/src/lib/kernel/connector-owner-did';
import { publicOrigin } from '@/src/lib/http/public-origin';
import { connectAndProvisionWebhook, keySealed } from '@/src/lib/stripe/connector';

const log = createLogger('kernel');

export async function OPTIONS(request: NextRequest): Promise<NextResponse> {
  return corsOptions(request) as NextResponse;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const cors = corsHeaders(request);

  const auth = await resolveConnectorOwnerDid(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status, headers: cors });
  }

  return NextResponse.json({ keySealed: await keySealed(auth.ownerDid) }, { headers: cors });
}

/** Optional non-empty trimmed string, or undefined. */
function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const cors = corsHeaders(request);

  const auth = await resolveConnectorOwnerDid(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status, headers: cors });
  }
  const { ownerDid } = auth;

  let body: { token?: unknown };
  try {
    body = (await request.json()) as { token?: unknown };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: cors });
  }

  const token = optionalString(body.token);
  if (!token) {
    return NextResponse.json(
      { error: 'token must be a non-empty string' },
      { status: 400, headers: cors },
    );
  }

  try {
    await connectAndProvisionWebhook(ownerDid, token, publicOrigin(request));
    log.info({ ownerDid }, 'Stripe restricted key sealed and webhook provisioned');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err: message, ownerDid }, 'Stripe connect failed');
    // stripe_key_not_restricted is a caller mistake (400); anything else
    // (provisioning failure against Stripe's API) is a 502-shaped failure
    // reported as 500 to match this codebase's other connector routes.
    const status = message.startsWith('stripe_key_not_restricted') ? 400 : 500;
    return NextResponse.json({ error: 'Failed to connect Stripe', detail: message }, { status, headers: cors });
  }

  return NextResponse.json({ sealed: true }, { status: 201, headers: cors });
}
