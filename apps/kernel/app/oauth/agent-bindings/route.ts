import { NextRequest, NextResponse } from 'next/server';
import { getEffectiveDid } from '@/app/auth/lib/get-effective-did';
import { AgentOAuthError, agentConsentChoices } from '@/src/lib/mcp/agent-binding';

export const dynamic = 'force-dynamic';

/** Only choices this authenticated human may approve; no public assignment list. */
export async function GET(request: NextRequest) {
  const headers = { 'Cache-Control': 'no-store' };
  const { sessionDid } = await getEffectiveDid();
  if (!sessionDid) return NextResponse.json({ error: 'login_required' }, { status: 401, headers });
  const agentDid = request.nextUrl.searchParams.get('agent_did');
  if (!agentDid || !/^did:[a-z0-9]+:[^\s]+$/.test(agentDid) || agentDid.length > 256) {
    return NextResponse.json({ error: 'agent_binding_required', error_description: 'Enter an agent DID on the consent screen.' },
      { status: 400, headers });
  }
  try {
    return NextResponse.json(await agentConsentChoices(agentDid, sessionDid), { headers });
  } catch (error) {
    if (!(error instanceof AgentOAuthError)) throw error;
    return NextResponse.json({ error: error.code, error_description: error.message }, { status: error.status, headers });
  }
}
