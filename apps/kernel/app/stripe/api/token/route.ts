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
 *   GET  → `{ keySealed, publishableKeySealed }`. Status only, never key values.
 *   POST → seals `{ token, publishableKey }` (a same-mode pair) AND provisions the
 *          owner's webhook endpoint. `token` matches the generic
 *          `credentialBodyKey` contract the connector card already posts.
 *
 * Security invariants: the restricted key and the webhook signing secret are
 * never logged, never returned, never echoed.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createLogger } from '@imajin/logger';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { resolveConnectorOwnerDid } from '@/src/lib/kernel/connector-owner-did';
import { publicOrigin } from '@/src/lib/http/public-origin';
import { connectAndProvisionWebhook, keySealed, publishableKeySealed } from '@/src/lib/stripe/connector';
import { StripeCredentialError, validateStripeCredentialPair } from '@/src/lib/stripe/credential-pair';

const log = createLogger('kernel');

/** `connectAndProvisionWebhook` failures that are the pasted key's fault, not ours or Stripe's. */
const CALLER_MISTAKES = ['stripe_key_not_restricted', 'stripe_key_missing_permission'];

export async function GET(request: NextRequest): Promise<NextResponse> {
  const cors = corsHeaders(request);

  const auth = await resolveConnectorOwnerDid(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status, headers: cors });
  }

  const [sealed, publicSealed] = await Promise.all([
    keySealed(auth.ownerDid),
    publishableKeySealed(auth.ownerDid),
  ]);
  return NextResponse.json({ keySealed: sealed, publishableKeySealed: publicSealed }, { headers: cors });
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

  let body: { token?: unknown; publishableKey?: unknown } | null;
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: cors });
  }

  const token = optionalString(body?.token) ?? '';
  const publishableKey = optionalString(body?.publishableKey);
  try {
    validateStripeCredentialPair(token, publishableKey);
    await connectAndProvisionWebhook(ownerDid, token, publicOrigin(request), publishableKey);
    log.info({ ownerDid }, 'Stripe restricted key sealed and webhook provisioned');
  } catch (err) {
    if (err instanceof StripeCredentialError) {
      return NextResponse.json(
        { error: err.message, code: err.code, field: err.field },
        { status: 400, headers: cors },
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    log.error({ ownerDid }, 'Stripe connect failed');
    // stripe_key_not_restricted and stripe_key_missing_permission (#2754: no
    // Checkout Sessions = Write) are caller mistakes (400); anything else
    // (provisioning failure against Stripe's API) is a 502-shaped failure
    // reported as 500 to match this codebase's other connector routes.
    const status = CALLER_MISTAKES.some((prefix) => message.startsWith(prefix)) ? 400 : 500;
    return NextResponse.json({ error: 'Failed to connect Stripe' }, { status, headers: cors });
  }

  return NextResponse.json({ sealed: true }, { status: 201, headers: cors });
}

export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';
