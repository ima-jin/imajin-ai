import { requireDomainManager } from '@/src/lib/domains/access';
import { removeDomain } from '@/src/lib/domains/service';
import { domainErrorResponse } from '@/src/lib/domains/http';

export const dynamic = 'force-dynamic';

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ did: string; domain: string }> },
) {
  try {
    const { did, domain } = await params;
    const caller = await requireDomainManager(request, did, { action: 'remove-domain', class: 'irreversible' });
    if (caller instanceof Response) return caller;
    await removeDomain(domain, did);
    return new Response(null, { status: 204 });
  } catch (error) {
    return domainErrorResponse(error);
  }
}
