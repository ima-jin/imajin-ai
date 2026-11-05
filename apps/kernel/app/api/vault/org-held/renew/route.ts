import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@imajin/auth';
import { enforceRoutePolicy } from '@imajin/auth/delegation-policy';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { generateId } from '@/src/lib/kernel/id';
import { computeApprovalContentHash } from '@/src/lib/notify/operator-approvals';
import { recordApprovalRequested } from '@/src/lib/notify/operator-approvals-service';
import { isImportHuman } from '@/src/lib/vault/import-authority';
import { ORG_HELD_RENEWAL_KIND, prepareOrgHeldRenewal, readOrgHeldRenewalInput } from '@/src/lib/vault/org-held-renewal';

export const dynamic = 'force-dynamic';

/** Proposal only. Execution is exclusively on the countersigned /jin approval rail. */
export async function POST(request: NextRequest) {
  const headers = { ...corsHeaders(request), 'Cache-Control': 'no-store' };
  const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers });
  const auth = await requireAuth(request, { sessionOnly: true, service: 'connections' });
  if ('error' in auth) return fail('Authentication required', auth.status);
  const refusal = enforceRoutePolicy(auth.identity, 'kernel.vault.org-held.renew', { headers });
  if (refusal) return refusal;
  let raw: unknown;
  try { raw = await request.json(); } catch { return fail('Invalid JSON', 400); }
  const input = readOrgHeldRenewalInput(raw);
  if (!input) return fail('Invalid organization key renewal request', 400);
  const { identity } = auth;
  if (identity.actingFor || (identity.actingAs && identity.actingAs !== input.orgDid)) return fail('Owner context required', 403);
  try {
    if (!await isImportHuman(identity.id)) return fail('A human owner or admin is required', 403);
    let detail;
    try {
      detail = await prepareOrgHeldRenewal({ actorDid: identity.id, orgDid: input.orgDid }, input);
    } catch {
      return fail('Renewal unavailable: check ownership and renew before grant material is erased', 409);
    }
    const proposal = {
      proposalId: generateId('vrenew'), source: 'vault', kind: ORG_HELD_RENEWAL_KIND,
      summary: `Renew ${input.provider} organization key for ${input.orgDid} until ${input.expiresAt}`,
      keysTouched: [], detail,
    };
    await recordApprovalRequested({
      ...proposal, contentHash: computeApprovalContentHash(proposal),
      operatorDid: identity.id, signerDid: identity.id, notificationId: null,
    });
    return NextResponse.json({ proposalId: proposal.proposalId, status: 'pending' }, { status: 201, headers });
  } catch {
    return fail('Organization key renewal unavailable', 503);
  }
}

export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';
