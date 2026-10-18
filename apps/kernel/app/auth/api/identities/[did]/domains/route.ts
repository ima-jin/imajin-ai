import { z } from 'zod';
import { requireDomainManager } from '@/src/lib/domains/access';
import { addDomain, listDomains } from '@/src/lib/domains/service';
import { domainErrorResponse } from '@/src/lib/domains/http';

export const dynamic = 'force-dynamic';

const addInput = z.object({
  domain: z.string().min(1).max(253),
  appDid: z.string().startsWith('did:imajin:').max(256).nullable().optional(),
}).strict();

type Context = { params: Promise<{ did: string }> };

export async function GET(request: Request, { params }: Context) {
  try {
    const { did } = await params;
    const caller = await requireDomainManager(request, did);
    if (caller instanceof Response) return caller;
    return Response.json({ domains: await listDomains(did) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return domainErrorResponse(error);
  }
}

export async function POST(request: Request, { params }: Context) {
  try {
    const { did } = await params;
    const caller = await requireDomainManager(request, did, { action: 'add-domain', class: 'value-moving' });
    if (caller instanceof Response) return caller;
    const input = addInput.safeParse(await request.json().catch(() => null));
    if (!input.success) {
      return Response.json({ error: 'Expected domain and optional appDid; siteOwner is registry-derived' }, { status: 400 });
    }
    const binding = await addDomain({ ...input.data, appDid: input.data.appDid ?? null, zoneOwner: did });
    return Response.json({ domain: binding }, { status: 201 });
  } catch (error) {
    return domainErrorResponse(error);
  }
}
