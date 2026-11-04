import { z } from 'zod';
import { enforceRoutePolicy } from '@imajin/auth/delegation-policy';
import { requireMailDomainManager } from '@/src/lib/mail/domain-access';
import { listDomains } from '@/src/lib/domains/service';
import { listMailDomainStates, provisionMailDomain } from '@/src/lib/mail/postal-domains';
import { mailDomainGuidance } from '@/src/lib/mail/domain-guidance';
import { mailDomainErrorResponse } from '@/src/lib/mail/domain-http';

export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ ownerDid: string }> };
const input = z.object({ domain: z.string().min(1).max(253) }).strict();

export async function GET(request: Request, { params }: Context) {
  try {
    const { ownerDid } = await params;
    const caller = await requireMailDomainManager(request, ownerDid);
    if (caller instanceof Response) return caller;
    const states = await listMailDomainStates(ownerDid);
    const bindings = await listDomains(ownerDid, true);
    const availableDomains = bindings.filter(binding => binding.zoneOwner === ownerDid).map(binding => binding.domain);
    const current = new Set(availableDomains);
    const domains = await Promise.all(states.map(async status => {
      const view = current.has(status.domain) ? status : { ...status, state: 'disabled' as const };
      return { ...view, guidance: await mailDomainGuidance(view) };
    }));
    return Response.json({ domains, availableDomains }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return mailDomainErrorResponse(error);
  }
}

export async function POST(request: Request, { params }: Context) {
  try {
    const { ownerDid } = await params;
    const caller = await requireMailDomainManager(request, ownerDid);
    if (caller instanceof Response) return caller;
    const denied = enforceRoutePolicy(caller, 'kernel.mail.domain.provision', { resourceId: ownerDid });
    if (denied) return denied;
    const parsed = input.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: 'invalid_mail_domain' }, { status: 400 });
    const domain = await provisionMailDomain(ownerDid, parsed.data.domain);
    return Response.json({ domain }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return mailDomainErrorResponse(error);
  }
}
