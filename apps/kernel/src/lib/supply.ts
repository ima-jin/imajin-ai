import { NextResponse, type NextRequest } from 'next/server';
import { requireAppAuth } from '@imajin/auth';
import { publish, getLotChain, type BusEventMap } from '@imajin/bus';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { generateId } from '@/src/lib/kernel/id';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

/**
 * #1135 — the four pre-sale supply stages this API can publish. Explicit
 * allowlist: an external app can never fire a non-supply.* event through these
 * routes (the routes are one-per-stage and each hard-codes its type).
 */
export type SupplyStageEvent =
  | 'supply.declared'
  | 'supply.collected'
  | 'supply.processed'
  | 'supply.listed';

/**
 * Shared handler for the supply stage POST routes. App-auth-gated
 * (`supply:write`); publishes the `supply.*` event on behalf of the human —
 * `issuer`/`subject` = `appAuth.userDid`, never the app DID. The lot id doubles
 * as the bus `correlationId` (what #1136's recorder keys the lot on): minted on
 * `declared` when the caller omits it, required on the later stages so they
 * thread onto the same lot.
 */
export async function publishSupplyStage(
  request: NextRequest,
  eventType: SupplyStageEvent,
): Promise<NextResponse> {
  const cors = corsHeaders(request);

  const appResult = await requireAppAuth(request, { scope: 'supply:write' });
  if ('error' in appResult) {
    return NextResponse.json({ error: appResult.error }, { status: appResult.status, headers: cors });
  }

  const userDid = appResult.appAuth.userDid;
  if (!userDid) {
    return NextResponse.json({ error: 'App token has no delegating user' }, { status: 403, headers: cors });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: cors });
  }

  // Lot identity: the bus correlationId (#1136 keys the lot on it) and the
  // payload lotId are the same value. declared mints one when omitted.
  const providedLotId = typeof body.lotId === 'string' && body.lotId.length > 0 ? body.lotId : null;
  const correlationId = providedLotId ?? (eventType === 'supply.declared' ? generateId('lot') : null);
  if (!correlationId) {
    return NextResponse.json(
      { error: 'lotId is required for this stage (obtain it from supply.declared)' },
      { status: 400, headers: cors },
    );
  }

  const commodity = typeof body.commodity === 'string' ? body.commodity : null;
  const unit = typeof body.unit === 'string' ? body.unit : null;
  const quantity = typeof body.quantity === 'number' ? body.quantity : null;
  if (!commodity || !unit || quantity === null) {
    return NextResponse.json(
      { error: 'commodity (string), quantity (number) and unit (string) are required' },
      { status: 400, headers: cors },
    );
  }

  const priorCid = typeof body.priorCid === 'string' ? body.priorCid : undefined;
  const base = {
    lotId: correlationId,
    supplierDid: userDid,
    commodity,
    quantity,
    unit,
    context_id: correlationId,
    context_type: 'supply',
  };
  const payload = (priorCid ? { ...base, priorCid } : base) as BusEventMap[SupplyStageEvent];

  // Awaited: #1136's supply-recorder is an awaited reactor, so the lot/stage
  // row is durable before we respond (read-after-write for the GET route).
  await publish(eventType, {
    issuer: userDid,
    subject: userDid,
    scope: 'supply',
    payload,
    correlationId,
  }).catch((err: unknown) => log.error({ err: String(err), eventType }, 'supply stage publish failed'));

  return NextResponse.json(
    { ok: true, correlationId, stage: eventType.slice('supply.'.length) },
    { status: 201, headers: cors },
  );
}

/**
 * Shared handler for `GET /supply/api/lot/[correlationId]`. App-auth-gated
 * (`supply:read`); returns the lot + its ordered stage history via #1136's
 * `getLotChain`.
 */
export async function handleLotGet(request: NextRequest, correlationId: string): Promise<NextResponse> {
  const cors = corsHeaders(request);

  const appResult = await requireAppAuth(request, { scope: 'supply:read' });
  if ('error' in appResult) {
    return NextResponse.json({ error: appResult.error }, { status: appResult.status, headers: cors });
  }

  try {
    const chain = await getLotChain(correlationId);
    if (!chain.lot) {
      return NextResponse.json({ error: 'Lot not found' }, { status: 404, headers: cors });
    }
    return NextResponse.json(chain, { headers: cors });
  } catch (err) {
    log.error({ err: String(err), correlationId }, 'supply lot chain read failed');
    return NextResponse.json({ error: 'Failed to load lot chain' }, { status: 500, headers: cors });
  }
}
