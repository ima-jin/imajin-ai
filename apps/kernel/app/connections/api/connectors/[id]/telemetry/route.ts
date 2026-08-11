/**
 * GET /connections/api/connectors/[id]/telemetry (#1799)
 *
 * Per-DID, per-connector-scope telemetry rollup: attestations and signed
 * connector actions the kernel has already signed under this connector's
 * registered scope(s), aggregated by kind with a total count and a time
 * range. See `@/src/lib/kernel/connector-telemetry` for the query shape.
 *
 * Query params:
 *   ownerDid    — defaults to the caller's own effective DID. The connector
 *                 grant owner whose telemetry is being read.
 *   consumerDid — optional. Narrows the rollup to one DID that acted /
 *                 drew on `ownerDid`'s connector resources. Omitted =
 *                 aggregated across every consumer.
 *
 * Access control: the caller must be `ownerDid` or `consumerDid` — never an
 * arbitrary third DID. This is what lets an owner see "who used my connector"
 * (ownerDid = me, consumerDid = them) and a consumer see "what did I draw
 * from them" (consumerDid = me, ownerDid = them), while keeping DID A from
 * ever reading DID B's telemetry by naming a pair neither side is in.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { resolveEffectiveDid } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { getConnector } from '@/src/lib/kernel/connector-registry';
import { readConnectorTelemetry } from '@/src/lib/kernel/connector-telemetry';

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

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const headers = responseHeaders(request);
  const { id } = await params;

  const entry = getConnector(id);
  if (!entry) {
    return NextResponse.json({ error: `Unknown connector: ${id}` }, { status: 404, headers });
  }

  const auth = await resolveEffectiveDid(request, { scope: 'connectors:read-telemetry' });
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status, headers });
  }
  const { effectiveDid } = auth;

  const { searchParams } = new URL(request.url);
  const ownerDid = searchParams.get('ownerDid') || effectiveDid;
  const consumerDid = searchParams.get('consumerDid') || null;

  // DID-level access control (#1799): a principal sees only telemetry rows
  // where THEY are one of the two named DIDs.
  if (effectiveDid !== ownerDid && effectiveDid !== consumerDid) {
    return NextResponse.json(
      { error: 'Forbidden — can only read your own connector telemetry' },
      { status: 403, headers },
    );
  }

  try {
    const rollup = await readConnectorTelemetry(entry, ownerDid, consumerDid);
    return NextResponse.json(rollup, { headers });
  } catch (err) {
    log.error(
      { err: String(err), connectorId: id, ownerDid, consumerDid },
      'Connector telemetry query failed',
    );
    return NextResponse.json(
      { error: 'Connector telemetry unavailable' },
      { status: 500, headers },
    );
  }
}
