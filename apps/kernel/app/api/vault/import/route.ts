/** Paste once; all responses and approval records contain metadata only. */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@imajin/auth';
import { enforceRoutePolicy } from '@imajin/auth/delegation-policy';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { generateId } from '@/src/lib/kernel/id';
import { computeApprovalContentHash } from '@/src/lib/notify/operator-approvals';
import { recordApprovalRequested } from '@/src/lib/notify/operator-approvals-service';
import { importProposer, listImportOwners, canExecuteImport } from '@/src/lib/vault/import-authority';
import { listImportedKeyCards, requireImportRotationTarget, validateImportBody } from '@/src/lib/vault/import';
import { stageImport, importFingerprint, discardImportForProposal, type ImportDetail } from '@/src/lib/vault/import-staging';
import { isVaultTier1 } from '@/src/lib/vault/sealing';

export const dynamic = 'force-dynamic';

async function authorize(request: NextRequest) {
  const headers = new Headers(corsHeaders(request));
  headers.set('Cache-Control', 'no-store');
  const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers });
  const auth = await requireAuth(request);
  if ('error' in auth) return { response: fail('Authentication required', auth.status) };
  const delegationRefusal = enforceRoutePolicy(auth.identity, 'kernel.vault.import', { headers });
  if (delegationRefusal) return { response: delegationRefusal };
  try {
    const proposer = await importProposer(auth.identity);
    if (!proposer) return { response: fail('A human approver is required', 403) };
    const owners = await listImportOwners(proposer.personDid);
    const preferred = auth.identity.actingAs ?? proposer.personDid;
    return { ...proposer, owners, ownerDid: owners.some(o => o.did === preferred) ? preferred : proposer.personDid, headers, fail, identity: auth.identity };
  } catch {
    return { response: fail('Import authorization unavailable', 503) };
  }
}

export async function GET(request: NextRequest) {
  const auth = await authorize(request);
  if (auth.response) return auth.response;
  const selected = request.nextUrl.searchParams.get('ownerDid');
  if (selected && !auth.owners.some(owner => owner.did === selected)) return auth.fail('Owner not authorized', 403);
  try {
    const cards = await listImportedKeyCards(selected ? [selected] : auth.owners.map(owner => owner.did));
    return NextResponse.json({ ownerDid: selected ?? auth.ownerDid, owners: auth.owners, cards }, { headers: auth.headers });
  } catch {
    return auth.fail('Import metadata unavailable', 503);
  }
}

export async function POST(request: NextRequest) {
  const auth = await authorize(request);
  if (auth.response) return auth.response;
  let raw: unknown;
  try { raw = await request.json(); } catch { return auth.fail('Invalid JSON', 400); }
  if (!validateImportBody(raw)) return auth.fail('Invalid vault import request', 400);
  if (!auth.owners.some(owner => owner.did === raw.ownerDid)) return auth.fail('Owner not authorized', 403);
  if (isVaultTier1()) return auth.fail('Vault import requires synchronous node custody', 409);
  const proposalId = generateId('vimport');
  const detail: ImportDetail = {
    ownerDid: raw.ownerDid, consumerDid: raw.consumerDid, purpose: raw.purpose.trim(),
    fingerprint: importFingerprint(raw.secret), label: raw.label ?? null,
    expiresAt: raw.expiresAt ? new Date(raw.expiresAt).toISOString() : null,
    replacesField: raw.replacesField ?? null,
  };
  let stagingRef: string | undefined;
  try {
    if (!(await canExecuteImport(auth.approverDid, detail.ownerDid))) return auth.fail('Approver cannot authorize this owner', 403);
    try { await requireImportRotationTarget(detail); } catch { return auth.fail('Import rotation target unavailable', 409); }
    stagingRef = await stageImport(proposalId, auth.approverDid, detail, raw.secret);
    const proposalDetail = { ...detail, stagingRef };
    const summary = `Import credential for ${detail.ownerDid}`;
    const proposal = { proposalId, source: 'vault', kind: 'vault:import', summary, keysTouched: [], detail: proposalDetail };
    const contentHash = computeApprovalContentHash(proposal);
    await recordApprovalRequested({
      ...proposal, contentHash, operatorDid: auth.approverDid, signerDid: auth.identity.id, notificationId: null,
    });
    return NextResponse.json({
      proposalId, fingerprint: detail.fingerprint, purpose: detail.purpose, status: 'pending',
    }, { status: 201, headers: auth.headers });
  } catch {
    if (stagingRef) await discardImportForProposal({
      proposalId, operatorDid: auth.approverDid, source: 'vault', kind: 'vault:import',
      detail: { ...detail, stagingRef }, status: 'denied',
    }).catch(() => undefined);
    return auth.fail('Import proposal unavailable', 503);
  }
}

export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';
