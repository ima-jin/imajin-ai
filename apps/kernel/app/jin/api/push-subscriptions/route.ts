/**
 * GET/POST/DELETE /jin/api/push-subscriptions — the operator's Web Push
 * (VAPID) subscription CRUD (#2291 — phone push path).
 *
 * Mirrors the auth posture of `POST /jin/api/vault-proposals`: only the
 * node operator, authenticated directly (never `@jin` acting on their
 * behalf — see `isOperatorIdentity`'s docblock), may subscribe/unsubscribe
 * a device. `GET` is the one exception that never 403s: like
 * `GET /jin/api/operator-approvals`, a non-operator gets
 * `{ isOperator: false }` with no key material, indistinguishable from
 * "nothing to see here" — the client-side subscribe button
 * (`push-subscribe-button.tsx`) renders nothing in that case.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@imajin/auth';
import { eq } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { generateId } from '@/src/lib/kernel/id';
import { db, pushSubscriptions } from '@/src/db';
import { getOperatorDid, isOperatorIdentity } from '@/src/lib/notify/operator-approvals';
import { getVapidPublicKey } from '@/src/lib/notify/vapid';

const log = createLogger('kernel:push-subscriptions');

export const dynamic = 'force-dynamic';

const MAX_ENDPOINT_LENGTH = 2000;
const MAX_KEY_LENGTH = 512;
const MAX_USER_AGENT_LENGTH = 300;

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

interface SubscribeBody {
  endpoint?: unknown;
  keys?: { p256dh?: unknown; auth?: unknown };
}

type OperatorGateResult = { response: NextResponse } | { response: null; operatorDid: string };

/** Shared operator-identity gate for the two mutating verbs below. */
async function requireOperator(request: NextRequest, cors: Record<string, string>): Promise<OperatorGateResult> {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return { response: NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors }) };
  }

  const operatorDid = await getOperatorDid();
  if (!operatorDid || !isOperatorIdentity(authResult.identity, operatorDid)) {
    return { response: NextResponse.json({ error: 'Only the node operator may manage push subscriptions' }, { status: 403, headers: cors }) };
  }

  return { response: null, operatorDid };
}

function isNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function validateSubscribeBody(body: SubscribeBody): { ok: true; endpoint: string; p256dh: string; auth: string } | { ok: false; error: string } {
  if (!isNonEmptyString(body.endpoint, MAX_ENDPOINT_LENGTH)) {
    return { ok: false, error: 'endpoint is required' };
  }
  const keys = body.keys;
  if (!keys || !isNonEmptyString(keys.p256dh, MAX_KEY_LENGTH) || !isNonEmptyString(keys.auth, MAX_KEY_LENGTH)) {
    return { ok: false, error: 'keys.p256dh and keys.auth are required' };
  }
  return { ok: true, endpoint: body.endpoint, p256dh: keys.p256dh, auth: keys.auth };
}

/**
 * GET reports whether the caller is the operator plus the VAPID public key
 * the browser needs for `PushManager.subscribe({applicationServerKey})`.
 * Never reveals existing subscriptions or their key material.
 */
export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }

  const operatorDid = await getOperatorDid();
  if (!operatorDid || !isOperatorIdentity(authResult.identity, operatorDid)) {
    return NextResponse.json({ isOperator: false }, { headers: cors });
  }

  const publicKey = await getVapidPublicKey();
  return NextResponse.json({ isOperator: true, publicKey }, { headers: cors });
}

/**
 * Upsert a subscription on `endpoint` (globally unique per the Push API
 * spec) — a re-subscribe (e.g. the browser silently rotated the
 * registration) simply refreshes the row rather than erroring on a
 * duplicate key.
 */
export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  const gate = await requireOperator(request, cors);
  if (gate.response) return gate.response;

  let body: SubscribeBody;
  try {
    body = (await request.json()) as SubscribeBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: cors });
  }

  const validation = validateSubscribeBody(body);
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400, headers: cors });
  }
  const { endpoint, p256dh, auth } = validation;
  const userAgent = (request.headers.get('user-agent') ?? '').slice(0, MAX_USER_AGENT_LENGTH) || null;

  try {
    await db
      .insert(pushSubscriptions)
      .values({
        id: generateId('psub'),
        operatorDid: gate.operatorDid,
        endpoint,
        p256dh,
        auth,
        userAgent,
        revokedAt: null,
      })
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: { operatorDid: gate.operatorDid, p256dh, auth, userAgent, revokedAt: null },
      });
    return NextResponse.json({ ok: true }, { status: 201, headers: cors });
  } catch (err) {
    log.error({ err: String(err), operatorDid: gate.operatorDid }, 'Failed to record push subscription');
    return NextResponse.json({ error: 'Failed to save push subscription' }, { status: 500, headers: cors });
  }
}

/**
 * Unsubscribe: soft-deletes (`revokedAt`) rather than deleting the row —
 * same posture as `notify.notifications`' delivered/read columns, and
 * cheap to reconcile against a duplicate unsubscribe call. Idempotent:
 * unsubscribing an endpoint that's already revoked, or was never known,
 * both return `{ ok: true }`.
 */
export async function DELETE(request: NextRequest) {
  const cors = corsHeaders(request);

  const gate = await requireOperator(request, cors);
  if (gate.response) return gate.response;

  let body: { endpoint?: unknown };
  try {
    body = (await request.json()) as { endpoint?: unknown };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: cors });
  }

  if (!isNonEmptyString(body.endpoint, MAX_ENDPOINT_LENGTH)) {
    return NextResponse.json({ error: 'endpoint is required' }, { status: 400, headers: cors });
  }

  try {
    await db
      .update(pushSubscriptions)
      .set({ revokedAt: new Date() })
      .where(eq(pushSubscriptions.endpoint, body.endpoint));
    return NextResponse.json({ ok: true }, { headers: cors });
  } catch (err) {
    log.error({ err: String(err), operatorDid: gate.operatorDid }, 'Failed to revoke push subscription');
    return NextResponse.json({ error: 'Failed to remove push subscription' }, { status: 500, headers: cors });
  }
}
