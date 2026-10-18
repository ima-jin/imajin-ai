import { NextRequest, NextResponse } from 'next/server';
import { domainFromHost, publicDomainEvidence } from '@/src/lib/domains/routing';

export const dynamic = 'force-dynamic';

/** The response contains the signed record, not an unverified footer claim. */
export async function GET(request: NextRequest) {
  const domain = domainFromHost(request.headers.get('host'));
  if (!domain) return NextResponse.json({ error: 'Invalid host' }, { status: 400 });
  const evidence = await publicDomainEvidence(domain);
  return NextResponse.json(evidence ?? { error: 'No verified domain binding' }, {
    status: evidence ? 200 : 404,
    headers: { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
  });
}
