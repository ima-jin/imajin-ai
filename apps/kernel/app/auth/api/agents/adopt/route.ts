import { NextRequest, NextResponse } from 'next/server';
import { authErrorResponse, resolveActingDid, validateGrantCapabilities } from '@imajin/auth';
import { requireGrantPrincipal } from '@/src/lib/auth/grant-principal';
import { AdoptionError, prepareAdoption, adoptAgent } from '@/src/lib/auth/agent-adoption';

export const dynamic = 'force-dynamic';

/** Two-stage principal-authenticated org adoption. Request bodies never carry private keys. */
export async function POST(request: NextRequest) {
  const auth = await requireGrantPrincipal(request);
  if ('error' in auth) return authErrorResponse(auth);
  const principal = { actorDid: auth.identity.id, orgDid: resolveActingDid(auth.identity) };
  try {
    const body = await request.json() as Record<string, unknown>;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'JSON object required' }, { status: 400 });
    }
    if (body.action === 'challenge') {
      if (typeof body.agentDid !== 'string' || !body.agentDid.startsWith('did:imajin:')) {
        return NextResponse.json({ error: 'agentDid must be an Imajin DID' }, { status: 400 });
      }
      if (!Array.isArray(body.capabilities) || body.capabilities.length === 0
        || body.capabilities.some(c => typeof c !== 'string')) {
        return NextResponse.json({ error: 'Select at least one capability' }, { status: 400 });
      }
      const { valid, invalid } = validateGrantCapabilities(body.capabilities);
      if (invalid.length) return NextResponse.json({ error: 'Unknown capabilities' }, { status: 400 });
      return NextResponse.json(await prepareAdoption({ ...principal, agentDid: body.agentDid, capabilities: valid }));
    }
    if (body.action !== 'adopt' || typeof body.challengeId !== 'string' || typeof body.signature !== 'string') {
      return NextResponse.json({ error: 'action, challengeId and signature required' }, { status: 400 });
    }
    return NextResponse.json(await adoptAgent({ ...principal, challengeId: body.challengeId, signature: body.signature }));
  } catch (error) {
    if (error instanceof AdoptionError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof SyntaxError) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    return NextResponse.json({ error: 'Unable to adopt agent' }, { status: 500 });
  }
}
