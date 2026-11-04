import { NextRequest, NextResponse } from 'next/server';
import { rateLimit, getClientIP } from '@imajin/config';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { resolveInferenceAuth } from '@/src/lib/inference/auth';
import { inferenceBrainContext } from '@/src/lib/inference/route-context';
import { listUsableModels } from '@/src/lib/inference/brain';
import { listInferenceRoutes } from '@/src/lib/inference/route-discovery';
import { readInferencePrincipal } from '@/src/lib/inference/route-discovery-store';
import { discoveryInferenceRoutes, discoveryModels } from '@/src/lib/inference/self-discovery';
import { listDiscoveryConnectorMetadata } from '@/src/lib/inference/self-discovery-connectors';
import { ExternalMcpError } from '@/src/lib/kernel/external-mcp-policy';

export const dynamic = 'force-dynamic';

/** Read-only projection of the existing completions gate, never an authority source. */
export async function GET(request: NextRequest) {
  const headers = {
    ...corsHeaders(request), 'Cache-Control': 'private, no-store',
    Vary: 'Cookie, Authorization, x-api-key, x-acting-as, x-acting-for',
  };
  const limit = rateLimit(getClientIP(request), 30, 60_000);
  if (limit.limited) return NextResponse.json(
    { error: 'Too many requests', retryAfter: limit.retryAfter },
    { status: 429, headers: { ...headers, 'Retry-After': String(limit.retryAfter) } },
  );
  const auth = await resolveInferenceAuth(request, 'infer:completions');
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status, headers });

  try {
    const context = auth.context;
    const actorDid = context.caller?.actorDid ?? context.orgContext?.memberDid ?? context.ownerDid;
    const identity = await readInferencePrincipal(actorDid);
    if (!identity) return NextResponse.json({ error: 'Identity not found' }, { status: 404, headers });
    // Model readiness/grant denials remain visible as diagnostic rows. Auth
    // failures above retain exactly the usable-model route's rejection shape.
    const models = await listUsableModels(inferenceBrainContext(context)).catch(error => {
      if (error instanceof ExternalMcpError && error.status === 403) return [];
      throw error;
    });
    // Org-held cards select models per call, not in the sealed key. Evaluate
    // their route with a model the canonical catalog actually advertises.
    const model = models.at(0)?.modelId;
    const routes = await listInferenceRoutes(context, model ? { model } : undefined);
    const metadata = await listDiscoveryConnectorMetadata(actorDid);
    return NextResponse.json({
      identity: {
        did: identity.did, handle: identity.handle, kind: identity.subtype ?? identity.scope,
        tier: identity.tier, actAs: context.caller?.actingAs ?? context.orgContext?.orgDid ?? null,
      },
      usableModels: discoveryModels(models),
      connectors: [...discoveryInferenceRoutes(routes, models, context), ...metadata],
    }, { headers });
  } catch {
    // Custody/store/provider exception strings may contain credentials.
    return NextResponse.json({ error: 'self_discovery_unavailable' }, { status: 503, headers });
  }
}

export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';
