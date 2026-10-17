import { canonicalize, audienceAllows, type DelegationAudience } from '@imajin/auth';
import type { BusEvent } from './types';

export const REACH_REPLY_EVENT = 'agent.reach.replied';

export interface ReachReplyEntitlement {
  readonly requesterDid: string;
  /** Original grant, or reach:<reachId> for gate-admitted receipt ownership. */
  readonly grantId: string;
  readonly reply: BusEvent;
}

interface EntitlementRow {
  readonly reach_id: string;
  readonly requester_did: string;
  readonly grant_id: string | null;
  readonly audience: DelegationAudience | null;
  readonly principal_did: string;
  readonly reply: BusEvent;
}

/** Discard bus bookkeeping: the principal signed exactly these five fields. */
export function reachReplyEventIdentity(event: BusEvent): string {
  return canonicalize({
    type: event.type, issuer: event.issuer, subject: event.subject,
    scope: event.scope, payload: event.payload,
  });
}

/**
 * A reply is readable only by the authenticated requester of its committed
 * envelope, and only while the original authority remains valid. A broad
 * grant cannot expose another requester's reply. Gate-backed admission is
 * explicit provenance, never inferred from a missing/revoked grant.
 *
 * #1884 signed tier is authentication mode, NOT trust level. A verified
 * legacy requesterSignature records signed delivery when requesterAuthTier
 * is absent. Reach requesterTier (hard/soft admission vocabulary) is not
 * authorization. Future bearer-tier transports must add their own credential check;
 * neither an opaque replyHandle nor a claimed payload requester authorizes.
 */
export async function loadReachReplyEntitlements(requesterDid?: string): Promise<ReachReplyEntitlement[]> {
  const { getClient } = await import('@imajin/db');
  const sql = getClient();
  const rows = await sql<EntitlementRow[]>`
    SELECT e.reach_id, e.requester_did, e.principal_did, e.envelope->>'grantId' AS grant_id,
           e.envelope->'reply' AS reply, g.audience
    FROM auth.reach_envelopes e
    LEFT JOIN auth.identities i ON i.id = e.requester_did
    LEFT JOIN auth.delegation_grants g
      ON g.id = e.envelope->>'grantId'
      AND g.agent_did = e.requester_did AND g.delegator_did = e.principal_did
      AND g.status = 'active' AND g.expires_at > now()
      AND EXISTS (
        SELECT 1 FROM auth.delegation_grant_capabilities c
        WHERE c.grant_id = g.id AND c.capability = 'agent:reach' AND c.status = 'active'
      )
    WHERE (${requesterDid ?? null}::text IS NULL OR e.requester_did = ${requesterDid ?? null})
      AND i.suspended_at IS NULL
      AND (
        e.envelope->>'requesterAuthTier' = 'signed'
        OR (
          NOT (e.envelope ? 'requesterAuthTier')
          AND e.envelope->>'requesterSignature' ~ '^[0-9a-fA-F]{128}$'
        )
      )
      AND jsonb_typeof(e.envelope->'reply') = 'object'
      AND e.envelope->'reply'->>'type' = 'agent.reach.replied'
      AND e.envelope->'reply'->>'issuer' = e.principal_did
      AND e.envelope->'reply'->>'subject' = e.principal_did
      AND e.envelope->'reply'->>'scope' = 'agent'
      AND e.envelope->'reply'->'payload'->>'reachId' = e.reach_id
      AND e.envelope->'reply'->'payload'->>'principalDid' = e.principal_did
      AND e.envelope->'reply'->'payload'->>'requesterDid' = e.requester_did
      AND e.envelope->'reply'->'payload'->>'transcriptHash' = e.transcript_hash
      AND (
        g.id IS NOT NULL
        OR jsonb_typeof(e.envelope->'grantId') = 'null'
      )
      AND NOT EXISTS (
        SELECT 1 FROM auth.reach_sender_blocks b
        WHERE b.principal_did = e.principal_did AND b.requester_did = e.requester_did
      )
  `;
  return rows
    .filter((row) => row.audience === null || audienceAllows(row.audience, row.principal_did))
    .map((row) => ({
      requesterDid: row.requester_did,
      grantId: row.grant_id ?? `reach:${row.reach_id}`,
      reply: row.reply,
    }));
}

export function matchingReachReplyEntitlements(
  event: BusEvent,
  entitlements: readonly ReachReplyEntitlement[],
): ReachReplyEntitlement[] {
  if (event.type !== REACH_REPLY_EVENT) return [];
  const identity = reachReplyEventIdentity(event);
  return entitlements.filter((entry) => reachReplyEventIdentity(entry.reply) === identity);
}
