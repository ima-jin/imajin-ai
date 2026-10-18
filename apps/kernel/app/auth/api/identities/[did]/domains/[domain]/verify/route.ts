import { requireDomainManager } from '@/src/lib/domains/access';
import { verifyDomain } from '@/src/lib/domains/service';
import { domainErrorResponse } from '@/src/lib/domains/http';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ did: string; domain: string }> },
) {
  try {
    const { did, domain } = await params;
    const caller = await requireDomainManager(request, did, { action: 'verify-domain', class: 'value-moving' });
    if (caller instanceof Response) return caller;
    return Response.json({ domain: await verifyDomain(domain, did) });
  } catch (error) {
    return domainErrorResponse(error);
  }
}
