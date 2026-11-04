import { enforceRoutePolicy } from '@imajin/auth/delegation-policy';
import { requireMailDomainManager } from '@/src/lib/mail/domain-access';
import { checkMailDomain } from '@/src/lib/mail/postal-domains';
import { mailDomainErrorResponse } from '@/src/lib/mail/domain-http';

export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ ownerDid: string; domain: string }> };

export async function POST(request: Request, { params }: Context) {
  try {
    const { ownerDid, domain } = await params;
    const caller = await requireMailDomainManager(request, ownerDid);
    if (caller instanceof Response) return caller;
    const denied = enforceRoutePolicy(caller, 'kernel.mail.domain.check', { resourceId: ownerDid });
    if (denied) return denied;
    return Response.json({ domain: await checkMailDomain(ownerDid, domain) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return mailDomainErrorResponse(error);
  }
}
