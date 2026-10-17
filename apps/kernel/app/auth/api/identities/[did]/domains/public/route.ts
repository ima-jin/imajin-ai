import { listDomains, normalizeDomain } from '@/src/lib/domains/service';
import { domainErrorResponse } from '@/src/lib/domains/http';

export const dynamic = 'force-dynamic';

/** Public evidence only: never pending, revoked or routing-only legacy rows. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ did: string }> },
) {
  try {
    const { did } = await params;
    const input = new URL(request.url).searchParams.get('domain');
    const domain = input === null ? null : normalizeDomain(input);
    const bindings = await listDomains(did, true);
    const domains = bindings.filter((binding) => binding.status === 'verified' && binding.attestation
      && (domain === null || binding.domain === domain));
    return Response.json({ domains }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return domainErrorResponse(error);
  }
}
