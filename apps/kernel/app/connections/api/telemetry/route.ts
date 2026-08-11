/**
 * POST/GET /connections/api/telemetry (#1677)
 *
 * The telemetry ingestion pattern — a sibling to the connector framework's
 * credential ingestion patterns (`token-paste`, `oauth`, `static-secret`),
 * except the payload is structured usage EVENTS rather than a credential.
 *
 * POST — an external tool, registered as a delegated app (#244) and granted
 * the `telemetry:write` scope by the delegating human, reports a batch of
 * structured usage events. DID attribution is anchored to that app's own
 * consent grant (`appAuth.userDid`), never trusted from the request body —
 * a caller cannot report telemetry "as" a DID it was not delegated by.
 *
 * GET — the delegating human (or an app they granted `telemetry:read` to)
 * reads their own per-schema usage projection, rolled up from the durable
 * `kernel.audit_log` trail the `audit-log` reactor writes on every accepted
 * event (see `packages/bus/src/config.ts`).
 *
 * Body (POST): { principal?: string, events: TelemetryEvent[] }
 *   principal, if given, MUST equal the caller's delegated DID — it exists so
 *   a caller can be explicit, not so it can name someone else.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAppAuth, resolveEffectiveDid } from '@imajin/auth';
import { publish } from '@imajin/bus';
import { createLogger } from '@imajin/logger';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { validateTelemetryEventBatch, MAX_TELEMETRY_BATCH_SIZE } from '@/src/lib/kernel/telemetry-ingest';
import { readTelemetryUsageProjection, DEFAULT_TELEMETRY_USAGE_ROW_LIMIT } from '@/src/lib/kernel/telemetry-usage';

const log = createLogger('kernel');

export const dynamic = 'force-dynamic';

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

function responseHeaders(request: NextRequest): Record<string, string> {
  return {
    ...corsHeaders(request),
    'Cache-Control': 'no-store',
  };
}

export async function POST(request: NextRequest) {
  const headers = responseHeaders(request);

  const appResult = await requireAppAuth(request, { scope: 'telemetry:write' });
  if ('error' in appResult) {
    return NextResponse.json({ error: appResult.error }, { status: appResult.status, headers });
  }
  const { appAuth } = appResult;

  if (!appAuth.userDid) {
    return NextResponse.json(
      { error: 'Telemetry ingestion requires a delegating user DID' },
      { status: 400, headers },
    );
  }
  const principal = appAuth.userDid;

  const body = await request.json().catch(() => null);
  if (body === null || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers });
  }

  const { principal: requestedPrincipal, events } = body as { principal?: unknown; events?: unknown };
  if (requestedPrincipal !== undefined && requestedPrincipal !== principal) {
    return NextResponse.json(
      { error: 'principal must match the delegating DID granted to this app' },
      { status: 403, headers },
    );
  }

  const validation = validateTelemetryEventBatch(events);
  if ('error' in validation) {
    return NextResponse.json({ error: validation.error }, { status: 400, headers });
  }
  const { accepted, rejected } = validation;

  await Promise.all(
    accepted.map((event) =>
      publish(event.type, {
        issuer: appAuth.appDid,
        subject: principal,
        scope: 'telemetry',
        payload: {
          schema: event.schema,
          data: event.data,
          ...(event.sessionRef ? { sessionRef: event.sessionRef } : {}),
          ...(event.agent ? { agent: event.agent } : {}),
          context_id: event.sessionRef ?? event.schema,
          context_type: 'telemetry' as const,
        },
      }).catch((err: unknown) => {
        log.error(
          { err: String(err), schema: event.schema, principal, connector: appAuth.appDid },
          'telemetry publish failed (non-fatal)',
        );
      }),
    ),
  );

  return NextResponse.json(
    { accepted: accepted.length, rejected, maxBatchSize: MAX_TELEMETRY_BATCH_SIZE },
    { status: 202, headers },
  );
}

export async function GET(request: NextRequest) {
  const headers = responseHeaders(request);

  const auth = await resolveEffectiveDid(request, { scope: 'telemetry:read' });
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status, headers });
  }

  const { searchParams } = new URL(request.url);
  const rawLimit = searchParams.get('limit');
  let rowLimit = DEFAULT_TELEMETRY_USAGE_ROW_LIMIT;
  if (rawLimit !== null) {
    const parsed = Number.parseInt(rawLimit, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      rowLimit = Math.min(parsed, 5000);
    }
  }

  try {
    const projection = await readTelemetryUsageProjection(auth.effectiveDid, rowLimit);
    return NextResponse.json(projection, { headers });
  } catch (err) {
    log.error({ err: String(err), principal: auth.effectiveDid }, 'Telemetry usage projection query failed');
    return NextResponse.json({ error: 'Telemetry usage unavailable' }, { status: 500, headers });
  }
}
