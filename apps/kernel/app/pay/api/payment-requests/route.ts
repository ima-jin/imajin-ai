/**
 * POST /pay/api/payment-requests — create (issuer-only)
 * GET  /pay/api/payment-requests — list, by issuer and/or by recipient
 *
 * See apps/kernel/src/lib/pay/payment-requests/service.ts for the
 * validation, manifest defaulting, content-hash, attestation, and bus-
 * publish logic this route delegates to.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { createLogger } from '@imajin/logger';
import { createPaymentRequest, isServiceError, listPaymentRequests } from '@/src/lib/pay/payment-requests/service';

const log = createLogger('kernel');

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

interface CreatePaymentRequestBody {
  issuer_did?: unknown;
  payee_account?: unknown;
  kind?: unknown;
  recipient_did?: unknown;
  recipient_stub_id?: unknown;
  line_items?: unknown;
  currency?: unknown;
  due_at?: unknown;
  allow_on_platform?: unknown;
  fair_manifest?: unknown;
}

export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }
  const callerDid = resolveActingDid(authResult.identity);

  let body: CreatePaymentRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: cors });
  }

  try {
    const result = await createPaymentRequest({
      callerDid,
      issuerDid: body.issuer_did,
      payeeAccount: body.payee_account,
      kind: body.kind,
      recipientDid: body.recipient_did,
      recipientStubId: body.recipient_stub_id,
      lineItems: body.line_items,
      currency: body.currency,
      dueAt: body.due_at,
      allowOnPlatform: body.allow_on_platform,
      fairManifest: body.fair_manifest,
    });
    if (isServiceError(result)) {
      return NextResponse.json({ error: result.error }, { status: result.status, headers: cors });
    }
    return NextResponse.json(result, { status: 201, headers: cors });
  } catch (error) {
    log.error({ err: String(error) }, 'payment_request create error');
    return NextResponse.json({ error: 'Failed to create payment_request' }, { status: 500, headers: cors });
  }
}

/**
 * A caller may only list payment_requests where they are the issuer or the
 * recipient — at least one of `issuer_did` / `recipient_did` must be
 * supplied and must match the authenticated caller.
 */
export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }
  const callerDid = resolveActingDid(authResult.identity);

  const { searchParams } = new URL(request.url);
  const issuerDid = searchParams.get('issuer_did');
  const recipientDid = searchParams.get('recipient_did');
  const status = searchParams.get('status');
  const kind = searchParams.get('kind');
  const limitParam = searchParams.get('limit');

  if (!issuerDid && !recipientDid) {
    return NextResponse.json(
      { error: 'issuer_did or recipient_did query param is required' },
      { status: 400, headers: cors },
    );
  }
  if (issuerDid && issuerDid !== callerDid) {
    return NextResponse.json({ error: 'issuer_did must match the authenticated principal' }, { status: 403, headers: cors });
  }
  if (recipientDid && recipientDid !== callerDid) {
    return NextResponse.json({ error: 'recipient_did must match the authenticated principal' }, { status: 403, headers: cors });
  }

  try {
    const rows = await listPaymentRequests({
      issuerDid,
      recipientDid,
      status,
      kind,
      limit: limitParam ? Number.parseInt(limitParam, 10) : undefined,
    });
    return NextResponse.json({ paymentRequests: rows }, { headers: cors });
  } catch (error) {
    log.error({ err: String(error) }, 'payment_request list error');
    return NextResponse.json({ error: 'Failed to list payment_requests' }, { status: 500, headers: cors });
  }
}
