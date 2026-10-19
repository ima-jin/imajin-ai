import { NextResponse } from 'next/server';
import { resolveReachDiscovery } from '@/src/lib/auth/reach-discovery';

export const dynamic = 'force-dynamic';
const headers = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };

/** Reach-only credentials are not the owner-approved agent-registration flow. */
export async function GET(_request: Request, { params }: { params: Promise<{ handle: string }> }) {
  try {
    const { handle } = await params;
    const card = await resolveReachDiscovery(handle);
    if (!card) return NextResponse.json({ error: 'Reach recipient not found' }, { status: 404, headers });
    return NextResponse.json({
      version: '0.1',
      flow: 'knock',
      card: card.url,
      instructions: card.instructionsUrl,
      principalDid: card.principalDid,
      credential: {
        method: 'POST',
        endpoint: card.onboarding.endpoint,
        contentType: 'application/json',
        example: {
          agentLabel: 'My assistant',
          onBehalfOf: { platform: 'YOUR_PLATFORM', externalRef: 'YOUR_OPAQUE_CALLER_REFERENCE' },
          slidingWindowDays: 30,
        },
        prerequisite: 'The recipient gate must admit soft-tier clients. No owner login, manually issued token or per-agent acceptance.',
        successStatus: 201,
        response: 'Save bearer from the response once, privately. requesterDid identifies your agent stub; audience is this recipient DID. onBehalfOf is UNVERIFIED.',
        use: 'Authorization: Bearer <YOUR_REACH_BEARER>',
        scope: 'agent:reach',
        expiry: 'Sliding expiry, with an unconditional 90-day hard cap. Revoked, expired and wrong-audience credentials fail.',
      },
      sequence: [
        'Read the public card anonymously and choose a supported transport.',
        'Knock for your own reach bearer, or use your own signed DID transcript.',
        'Ask a boolean topic question or send a message under the same reach gate.',
        'Save reachId; poll reach_status for the principal-signed reply using the same credential.',
      ],
      security: 'A credential is not consent. Anonymous access is discovery only. Never log or publish bearer values; private gate rules are never returned.',
    }, { headers });
  } catch {
    return NextResponse.json({ error: 'Reach onboarding unavailable' }, { status: 503, headers });
  }
}

export function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: { ...headers, 'Access-Control-Allow-Methods': 'GET, OPTIONS' },
  });
}
