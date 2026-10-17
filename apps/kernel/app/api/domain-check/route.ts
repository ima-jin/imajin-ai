import { NextRequest, NextResponse } from 'next/server';
import { normalizeDomain, resolveRoutableDomain, DomainError } from '@/src/lib/domains/service';

export const dynamic = 'force-dynamic';

/** Caddy on-demand TLS ask endpoint; pending/revoked claims never authorize. */
export async function GET(request: NextRequest) {
  try {
    const domain = normalizeDomain(request.nextUrl.searchParams.get('domain') ?? '');
    const binding = await resolveRoutableDomain(domain);
    return NextResponse.json({ allowed: Boolean(binding), verified: binding?.status === 'verified' }, {
      status: binding ? 200 : 404,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }
}
