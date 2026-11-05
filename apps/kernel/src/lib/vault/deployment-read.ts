import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { emitAttestation } from '@imajin/auth';
import { db, operatorApprovals, type VaultDelegationGrant } from '@/src/db';
import { computeApprovalContentHash } from '@/src/lib/notify/operator-approvals';
import { forEachSequential } from '@/src/lib/async/sequential';
import { ackGrant, fetchGrantSecret, getGrantById, listGrantsForGrantee } from './index';
import { isDeploymentReadImportedKeyField, parseVaultFieldName } from './field-grammar';
import { deploymentReadBinding, DEPLOYMENT_READ_PURPOSE, requireDeploymentReadBinding } from './deployment-read-binding';
import { getNodeSigningIdentity } from './sealing';
import {
  HEADER, sealDeliveryResponse, signingKey, verifyDeliveryRequest, type DeliveryClaim,
} from '../../../../../deploy/infer-passthrough/deployment-read-protocol.mjs';

const HEADERS = { 'Cache-Control': 'no-store' };
const REFUSAL = 'Deployment delivery unavailable';

async function approvedBinding(grant: VaultDelegationGrant): Promise<void> {
  const policy = deploymentReadBinding();
  if (grant.subject !== policy.ownerDid || grant.grantedTo !== policy.recipientDid
    || grant.purpose !== DEPLOYMENT_READ_PURPOSE || grant.oneTime || grant.status !== 'active'
    || !grant.expiresAt || grant.expiresAt.getTime() <= Date.now()
    || !isDeploymentReadImportedKeyField(grant.field)) throw new Error(REFUSAL);
  const field = parseVaultFieldName(grant.field);
  if (!field.ok) throw new Error(REFUSAL);
  const [proposal] = await db.select().from(operatorApprovals).where(and(
    eq(operatorApprovals.proposalId, field.value.name),
    eq(operatorApprovals.source, 'vault'), eq(operatorApprovals.kind, 'vault:import'),
    eq(operatorApprovals.status, 'applied'),
  )).limit(1);
  if (!proposal?.detail || !proposal.appliedAt) throw new Error(REFUSAL);
  const contentHash = computeApprovalContentHash({
    proposalId: proposal.proposalId, source: proposal.source, kind: proposal.kind,
    summary: proposal.summary, keysTouched: proposal.keysTouched, detail: proposal.detail,
  });
  if (contentHash !== proposal.contentHash) throw new Error(REFUSAL);
  requireDeploymentReadBinding(proposal.detail);
  if (proposal.detail.ownerDid !== grant.subject || proposal.detail.consumerDid !== grant.grantedTo
    || proposal.detail.purpose !== grant.purpose
    || Date.parse(proposal.detail.expiresAt as string) !== grant.expiresAt.getTime()) throw new Error(REFUSAL);
}

function acknowledgmentTime(body: string, grant: VaultDelegationGrant): string {
  const parsed = JSON.parse(body);
  if (!parsed || Object.keys(parsed).length !== 2 || parsed.outcome !== 'used'
    || typeof parsed.fetchedAt !== 'string' || parsed.fetchedAt !== grant.lastFetchedAt?.toISOString()) throw new Error(REFUSAL);
  return parsed.fetchedAt;
}

async function attest(claim: DeliveryClaim, action: 'fetched' | 'acked', grant: VaultDelegationGrant) {
  const node = getNodeSigningIdentity();
  // Await durable signed provenance. Never attach plaintext, ciphertext or free-form input.
  const receipt = await emitAttestation({
    issuer_did: node.senderDid, subject_did: claim.ownerDid, type: `vault.deployment-read.${action}`,
    context_id: grant.id, context_type: 'vault.delegation',
    payload: {
      repository: claim.repository, recipientDid: claim.recipientDid, purpose: claim.purpose,
      grantId: grant.id, field: grant.field, requestNonce: claim.nonce,
      expiresAt: grant.expiresAt!.toISOString(),
    },
  });
  if (!receipt.attestationId) throw new Error(REFUSAL);
}

function encrypted(value: unknown, claim: DeliveryClaim, expiresAt?: Date | null) {
  const deadline = Math.min(claim.timestamp + 60_000, expiresAt?.getTime() ?? Infinity);
  if (deadline <= Date.now()) throw new Error(REFUSAL);
  const node = getNodeSigningIdentity();
  return NextResponse.json(sealDeliveryResponse(value, claim, deadline, signingKey(node.privateKeyHex)), { headers: HEADERS });
}

async function listDeliveryGrants(claim: DeliveryClaim) {
  const candidates = await listGrantsForGrantee({ granteeDid: claim.recipientDid, purpose: DEPLOYMENT_READ_PURPOSE });
  const grants: Array<{ grantId: string; expiresAt: string; createdAt: string }> = [];
  await forEachSequential(candidates, async candidate => {
    const grant = await getGrantById(candidate.grantId);
    if (grant?.status !== 'active' || !grant.expiresAt || grant.expiresAt.getTime() <= Date.now()) return;
    await approvedBinding(grant);
    grants.push({ grantId: grant.id, expiresAt: grant.expiresAt.toISOString(), createdAt: grant.createdAt.toISOString() });
  });
  return encrypted({ grants }, claim);
}

/** Same three list/fetch/ack endpoints; no second secret-fetch surface. */
export async function deploymentReadRoute(request: Request, action: 'list' | 'fetch' | 'ack', grantId?: string) {
  try {
    const policy = deploymentReadBinding();
    const body = await request.text();
    const url = new URL(request.url);
    const claim = verifyDeliveryRequest(request.headers.get(HEADER), request.method,
      url.pathname + url.search, body, policy, policy.publicKey);
    if (action === 'list') {
      if (body || url.searchParams.get('purpose') !== DEPLOYMENT_READ_PURPOSE) throw new Error(REFUSAL);
      return await listDeliveryGrants(claim);
    }
    if (!grantId) throw new Error(REFUSAL);
    const grant = await getGrantById(grantId);
    if (!grant) throw new Error(REFUSAL);
    await approvedBinding(grant);
    if (action === 'ack') {
      const fetchedAt = acknowledgmentTime(body, grant);
      const result = await ackGrant({
        grantId, granteeDid: policy.recipientDid, outcome: 'used',
        deploymentReadDelivery: true, deploymentFetchedAt: fetchedAt,
      });
      if (result.status !== 'ok') throw new Error(REFUSAL);
      await attest(claim, 'acked', grant);
      return encrypted({ ok: true, ackedAt: result.ackedAt.toISOString() }, claim, grant.expiresAt);
    }
    if (body) throw new Error(REFUSAL);
    const result = await fetchGrantSecret({ grantId, granteeDid: policy.recipientDid, deploymentReadDelivery: true });
    if (result.status !== 'ok') throw new Error(REFUSAL);
    // Recheck after decrypt so a concurrent rotation/revocation cannot authorize a stale response.
    const current = await getGrantById(grantId);
    if (!current) throw new Error(REFUSAL);
    await approvedBinding(current);
    await attest(claim, 'fetched', current);
    return encrypted({
      value: result.value, grantId, field: grant.field, expiresAt: grant.expiresAt!.toISOString(),
      fetchedAt: result.grant.lastFetchedAt!.toISOString(),
      repository: claim.repository, purpose: claim.purpose, recipientDid: claim.recipientDid,
    }, claim, grant.expiresAt);
  } catch {
    // Includes crypto, DB and attestation errors: never serialize underlying diagnostics.
    return NextResponse.json({ error: REFUSAL }, { status: 403, headers: HEADERS });
  }
}
