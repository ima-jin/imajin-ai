import { and, eq, gt, inArray } from 'drizzle-orm';
import { audienceAllows, isDelegationAudience, verify, type SignedMessage } from '@imajin/auth';
import { db, identities, delegationGrants, delegationGrantCapabilities } from '@/src/db';
import { getNodeSelfInfo } from '@/src/lib/kernel/node-identity';

export const APPROVALS_LEASE_OPERATION = 'operator:approvals:lease';
const CAPABILITY = 'operator:approvals';

/** No session, internal key or acting-identity overlay can substitute for this signer. */
export async function authenticateLeaseReader(raw: unknown): Promise<string | null> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const message = raw as SignedMessage;
  if (message.type !== 'agent' || typeof message.from !== 'string'
    || !Number.isSafeInteger(message.timestamp) || !message.payload
    || typeof message.payload !== 'object' || Array.isArray(message.payload)
    || (message.payload as Record<string, unknown>).operation !== APPROVALS_LEASE_OPERATION) return null;

  const [identity] = await db.select({
    publicKey: identities.publicKey, subtype: identities.subtype, suspendedAt: identities.suspendedAt,
  }).from(identities).where(eq(identities.id, message.from)).limit(1);
  if (identity?.subtype !== 'agent' || identity.suspendedAt) return null;
  const result = await verify(message, identity.publicKey);
  return result.valid ? message.from : null;
}

export interface OperatorApprovalsLease {
  grantId: string;
  capability: 'operator:approvals';
  expiresAt: string;
}

/** Read-only: do not mark a grant used or disclose issuer, audience, history or proofs. */
export async function effectiveOperatorApprovalsLease(agentDid: string): Promise<OperatorApprovalsLease | null> {
  const operatorDid = (await getNodeSelfInfo())?.nodeOperatorDid;
  if (!operatorDid) return null;
  const grants = await db.select({
    grantId: delegationGrants.id, expiresAt: delegationGrants.expiresAt, audience: delegationGrants.audience,
  }).from(delegationGrants).where(and(
    eq(delegationGrants.agentDid, agentDid),
    eq(delegationGrants.status, 'active'),
    gt(delegationGrants.expiresAt, new Date()),
  ));
  if (grants.length === 0) return null;
  const capabilities = await db.select({ grantId: delegationGrantCapabilities.grantId })
    .from(delegationGrantCapabilities).where(and(
      inArray(delegationGrantCapabilities.grantId, grants.map(grant => grant.grantId)),
      eq(delegationGrantCapabilities.capability, CAPABILITY),
      eq(delegationGrantCapabilities.status, 'active'),
    ));
  const eligibleIds = new Set(capabilities.map(row => row.grantId));
  const eligible = grants.filter(grant => eligibleIds.has(grant.grantId)
    && isDelegationAudience(grant.audience) && audienceAllows(grant.audience, operatorDid));
  // Any eligible grant keeps delivery alive. Stable ID ordering breaks equal-expiry ties.
  eligible.sort((a, b) => b.expiresAt.getTime() - a.expiresAt.getTime() || a.grantId.localeCompare(b.grantId));
  const grant = eligible.at(0);
  return grant ? { grantId: grant.grantId, capability: CAPABILITY, expiresAt: grant.expiresAt.toISOString() } : null;
}
