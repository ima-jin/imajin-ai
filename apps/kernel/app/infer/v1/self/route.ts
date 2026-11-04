import { NextRequest, NextResponse } from 'next/server';
import { rateLimit, getClientIP } from '@imajin/config';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { resolveInferenceAuth } from '@/src/lib/inference/auth';
import { resolveInferenceRouteContext } from '@/src/lib/inference/route-context';
import { readSelfDiscoveryCard } from '@/src/lib/inference/self-discovery-card';
import { requireGrantPrincipal } from '@/src/lib/auth/grant-principal';
import { listServingAgents } from '@/src/lib/auth/agent-service';
import { listGrantDetailsForDelegator } from '@/src/lib/auth/grants';
import { resolveActingDid } from '@imajin/auth';

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

  try {
    const agents = request.nextUrl.searchParams.get('agents');
    if (agents !== null) {
      if (agents !== '1') return NextResponse.json({ error: 'agents must be 1' }, { status: 400, headers });
      return await operatorCards(request, headers);
    }
    const auth = await resolveInferenceAuth(request, 'infer:completions');
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status, headers });
    const card = await readSelfDiscoveryCard(auth.context);
    if (!card) return NextResponse.json({ error: 'Identity not found' }, { status: 404, headers });
    return NextResponse.json(card, { headers });
  } catch {
    // Custody/store/provider exception strings may contain credentials.
    return NextResponse.json({ error: 'self_discovery_unavailable' }, { status: 503, headers });
  }
}

async function operatorCards(request: NextRequest, headers: Record<string, string>) {
  const auth = await requireGrantPrincipal(request);
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status, headers });
  const principalDid = resolveActingDid(auth.identity);
  const agents = new Map((await listServingAgents(principalDid)).map(agent => [agent.did, agent]));
  for (const grant of await listGrantDetailsForDelegator(principalDid)) {
    if (!agents.has(grant.agentDid)) agents.set(grant.agentDid, { did: grant.agentDid, name: null, handle: null, servingSince: null });
  }
  const cards = [];
  for (const agent of agents.values()) {
    const caller = {
      actorDid: agent.did,
      ...(auth.identity.actingAs ? { actingAs: principalDid } : { actingFor: principalDid }),
    };
    const { context } = resolveInferenceRouteContext({ caller });
    const card = await readSelfDiscoveryCard(context, principalDid);
    if (card?.identity.kind === 'agent') cards.push({ ...card, name: agent.name });
  }
  return NextResponse.json({ principalDid, cards }, { headers });
}
export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';
