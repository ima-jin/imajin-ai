/**
 * GET /connections/api/connectors/[id]/spend (#1923)
 *
 * Per-connector inference spend burn-down: total spend, the connector's own
 * declared cap (if any), and breakdowns by session/turn/agent — the epic's
 * target architecture component 4 dashboard read. Only meaningful for the
 * brain connectors (Gemini, Anthropic, xAI, OpenAI, Moonshot); any other
 * connector id 404s, matching the telemetry route's precedent for an unknown
 * id.
 *
 * Access control mirrors the telemetry route exactly (#1799): the caller
 * must be the connector's own owner. There is no `consumerDid` axis here —
 * spend is an owner-level financial fact, not a per-consumer count.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { resolveEffectiveDid } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { getConnector } from '@/src/lib/kernel/connector-registry';
import { connectorRegistryId, readConnectorRegistration } from '@/src/lib/kernel/connector-registry-store';
import { readInferenceBurnDown } from '@/src/lib/inference/inference-burn-down';
import type { BrainConnectorId } from '@/src/lib/inference/brain';

const log = createLogger('kernel');

export const dynamic = 'force-dynamic';

/** The only connector ids `inference.usage` can ever name (see `brain.ts`'s `BRAIN_CONNECTORS`). */
const BRAIN_CONNECTOR_IDS: readonly string[] = ['gemini', 'anthropic', 'xai', 'openai', 'moonshot', 'zai'];

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
  if (!entry || !BRAIN_CONNECTOR_IDS.includes(id)) {
    return NextResponse.json({ error: `Unknown inference connector: ${id}` }, { status: 404, headers });
  }

  const auth = await resolveEffectiveDid(request, { scope: 'infer:usage-read' });
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status, headers });
  }
  const { effectiveDid: ownerDid } = auth;

  try {
    const registration = await readConnectorRegistration(ownerDid, id);
    const connectorId = registration?.id ?? connectorRegistryId(ownerDid, id);
    const burnDown = await readInferenceBurnDown(connectorId, id as BrainConnectorId, ownerDid, registration);
    return NextResponse.json(burnDown, { headers });
  } catch (err) {
    log.error({ err: String(err), connectorId: id, ownerDid }, 'Inference burn-down query failed');
    return NextResponse.json({ error: 'Inference burn-down unavailable' }, { status: 500, headers });
  }
}
