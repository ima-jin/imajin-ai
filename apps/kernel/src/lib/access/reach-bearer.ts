/**
 * Static-header reach credentials (#2591). The subject is THEIR agent stub,
 * never the recipient. `surfaces: ["reach:<recipient DID>"]` is the audience
 * binding; neither generic REST sessions nor the `mcp` surface can resolve it.
 * Existing #2252 tables are reused. Their legacy approval_id field records
 * `reach-gate:<DID>` authority, NOT an invented operator approval.
 */
import { randomBytes } from 'node:crypto';
import { getClient } from '@imajin/db';
import { emitAttestation } from '@imajin/auth';
import { publish } from '@imajin/bus';
import { createLogger } from '@imajin/logger';
import { generateId } from '@/src/lib/kernel/id';
import { getNodeDid } from '@/src/lib/kernel/node-identity';
import { generateOpaqueToken, hashToken } from '@/src/lib/mcp/oauth-config';
import { isTierAdmitted } from '@/src/lib/jin/front-door';
import { blockForeignAgentStub } from '@/src/lib/auth/foreign-agent-stub';
import { blockReachSender } from '@/src/lib/auth/reach-envelope-store';
import {
  DELEGATE_GRANT_HARD_CAP_DAYS,
  DELEGATE_GRANT_SLIDING_WINDOW_DAYS_OPTIONS,
} from './delegate-grant';
import type { ReachBearerKnock } from './reach-bearer-wire';

const log = createLogger('kernel:reach-bearer');
const DAY_MS = 86_400_000;
const REACH_SCOPES = ['agent:reach'];
export const reachBearerSurface = (principalDid: string) => `reach:${principalDid}`;

export interface ReachKnockInput {
  agentLabel: string;
  onBehalfOf: ReachBearerKnock['onBehalfOf'];
  slidingWindowDays: number;
}

function boundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

export function parseReachKnock(body: unknown):
  | { ok: true; input: ReachKnockInput }
  | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'body must be an object' };
  const value = body as Record<string, unknown>;
  if (!boundedText(value.agentLabel, 200)) return { ok: false, error: 'agentLabel is required (max 200 characters)' };
  const claim = value.onBehalfOf as Record<string, unknown> | null;
  if (!claim || !boundedText(claim.platform, 100) || !boundedText(claim.externalRef, 500)
    || (claim.selfDescription !== undefined && !boundedText(claim.selfDescription, 1000))) {
    return { ok: false, error: 'onBehalfOf requires platform and externalRef; this claim is UNVERIFIED' };
  }
  // 30 days gives a meaningful sliding window inside the unconditional 90-day cap.
  const days = value.slidingWindowDays ?? 30;
  if (typeof days !== 'number' || !(DELEGATE_GRANT_SLIDING_WINDOW_DAYS_OPTIONS as readonly number[]).includes(days)) {
    return { ok: false, error: 'slidingWindowDays must be 30, 90, 180 or 365' };
  }
  return { ok: true, input: {
    agentLabel: value.agentLabel.trim(),
    onBehalfOf: {
      platform: claim.platform, externalRef: claim.externalRef,
      ...(typeof claim.selfDescription === 'string' ? { selfDescription: claim.selfDescription } : {}),
    },
    slidingWindowDays: days,
  } };
}

interface PrincipalRow {
  id: string;
  metadata: Record<string, unknown> | null;
}

/** Resolve aliases before applying recipient quotas. Never mint a recipient. */
export async function resolveReachRecipient(handleOrDid: string): Promise<PrincipalRow | null> {
  const [row] = await getClient().unsafe<PrincipalRow[]>(`
    SELECT id, metadata FROM auth.identities
    WHERE (id = $1 OR handle = $1) AND scope = 'actor' AND subtype = 'human' AND suspended_at IS NULL
    LIMIT 1
  `, [handleOrDid]);
  return row ?? null;
}

function admitsStaticClient(metadata: PrincipalRow['metadata']): boolean {
  return !!metadata && Object.hasOwn(metadata, 'agentReachGate') && isTierAdmitted(metadata, 'soft');
}

/** Atomic issuance: no approval rail, no retrievable plaintext, no caller-selected authority. */
export async function issueReachBearer(principalDid: string, input: ReachKnockInput) {
  const checked = parseReachKnock(input);
  if (!checked.ok) return { ok: false as const, status: 400, error: checked.error };
  const bearer = generateOpaqueToken();
  const tokenHash = hashToken(bearer);
  const requestId = generateId('dgr');
  const bearerId = generateId('dgb');
  const random = randomBytes(32).toString('hex');
  const requesterDid = `did:imajin:foreign_${random}`;
  const now = new Date();
  const hardCapAt = new Date(now.getTime() + DELEGATE_GRANT_HARD_CAP_DAYS * DAY_MS);
  const expiresAt = new Date(Math.min(now.getTime() + checked.input.slidingWindowDays * DAY_MS, hardCapAt.getTime()));
  const surfaces = [reachBearerSurface(principalDid)];
  const purpose = JSON.stringify({ onBehalfOf: checked.input.onBehalfOf, claimVerified: false });
  const authority = `reach-gate:${principalDid}`;

  const issued = await getClient().begin('isolation level read committed', async (tx) => {
    // Same row lock as C3's stub block/rotation; a gate edit cannot race issuance.
    const [principal] = await tx.unsafe<PrincipalRow[]>(`
      SELECT id, metadata FROM auth.identities WHERE id = $1
        AND scope = 'actor' AND subtype = 'human' AND suspended_at IS NULL FOR UPDATE
    `, [principalDid]);
    if (!principal || !admitsStaticClient(principal.metadata)) return false;
    await tx.unsafe(`
      INSERT INTO auth.identities (id, scope, subtype, public_key, tier, metadata)
      VALUES ($1, 'actor', 'foreign_agent_stub', $2, 'soft', $3::jsonb)
    `, [requesterDid, `stub_${random}`, JSON.stringify({
      source: 'agent.reach', stub: true, capabilities: ['reach'], principalDid, credential: 'bearer',
    })]);
    // This random marker is NOT a signing key. The placeholder identity cannot log in.
    await tx.unsafe(`
      INSERT INTO auth.foreign_agent_stubs
        (stub_did, requester_did, signer_key, requester_aliases, principal_did)
      VALUES ($1, $1, $2, $3::jsonb, $4)
    `, [requesterDid, `bearer_${random}`, JSON.stringify([requesterDid]), principalDid]);
    await tx.unsafe(`
      INSERT INTO auth.delegate_grant_requests
        (id, principal_did, client_label, purpose, scopes, surfaces, sliding_window_days,
         status, approval_id, decided_at, expires_at)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, 'approved', $8, $9, $10)
    `, [requestId, requesterDid, checked.input.agentLabel, purpose, JSON.stringify(REACH_SCOPES),
      JSON.stringify(surfaces), checked.input.slidingWindowDays, authority, now.toISOString(), expiresAt.toISOString()]);
    await tx.unsafe(`
      INSERT INTO auth.delegate_grant_bearers
        (id, request_id, principal_did, client_label, purpose, scopes, surfaces, token_hash,
         sliding_window_days, issued_at, expires_at, hard_cap_at, status, approval_id)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11, $12, 'active', $13)
    `, [bearerId, requestId, requesterDid, checked.input.agentLabel, purpose, JSON.stringify(REACH_SCOPES),
      JSON.stringify(surfaces), tokenHash, checked.input.slidingWindowDays, now.toISOString(),
      expiresAt.toISOString(), hardCapAt.toISOString(), authority]);
    return true;
  });
  if (!issued) return { ok: false as const, status: 403, error: 'Reach gate does not admit static-header clients' };
  await attestReachBearer('access.knock', requesterDid, requestId, { principalDid, requestId, claimVerified: false });
  await attestReachBearer('access.bearer.issued', requesterDid, bearerId, {
    principalDid, bearerId, requestId, surfaces, scopes: REACH_SCOPES,
    authority: { type: 'reach-gate', principalDid }, expiresAt: expiresAt.toISOString(), hardCapAt: hardCapAt.toISOString(),
  });
  return { ok: true as const, bearer, bearerId, requestId, requesterDid, audience: principalDid,
    scopes: REACH_SCOPES, surfaces, claimVerified: false as const,
    expiresAt: expiresAt.toISOString(), hardCapAt: hardCapAt.toISOString() };
}

async function attestReachBearer(
  type: 'access.knock' | 'access.bearer.issued' | 'access.bearer.used',
  requesterDid: string, id: string, payload: Record<string, unknown>,
): Promise<void> {
  // Never log thrown DB/transport objects: they can contain bound query values.
  try {
    await emitAttestation({ issuer_did: await getNodeDid(), subject_did: requesterDid, type,
      context_id: id, context_type: 'access.bearer', payload });
  } catch {
    log.error({ type, id }, 'Reach credential attestation failed');
  }
}

interface UsedBearer {
  id: string;
  principal_did: string;
  purpose: string;
}

/** Live audience + capability + stub + sender-block checks precede an atomic expiry slide. */
export async function resolveReachBearer(token: string, principalDid: string):
  Promise<{ requesterDid: string; bearerId: string; onBehalfOf: ReachKnockInput['onBehalfOf'] } | null> {
  const [row] = await getClient().unsafe<UsedBearer[]>(`
    UPDATE auth.delegate_grant_bearers b
    SET last_used_at = now(),
        expires_at = LEAST(now() + (b.sliding_window_days || ' days')::interval, b.hard_cap_at)
    FROM auth.foreign_agent_stubs s, auth.identities p, auth.identities a
    WHERE b.token_hash = $1 AND b.status = 'active' AND b.expires_at > now() AND b.hard_cap_at > now()
      AND b.surfaces = $2::jsonb AND b.scopes = '["agent:reach"]'::jsonb
      AND s.stub_did = b.principal_did AND s.principal_did = $3
      AND s.capability = 'reach' AND s.revoked_at IS NULL
      AND p.id = s.principal_did AND p.suspended_at IS NULL AND p.scope = 'actor' AND p.subtype = 'human'
      AND a.id = s.stub_did AND a.suspended_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM auth.reach_sender_blocks r
        WHERE r.principal_did = $3 AND r.requester_did = b.principal_did)
    RETURNING b.id, b.principal_did, b.purpose
  `, [hashToken(token), JSON.stringify([reachBearerSurface(principalDid)]), principalDid]);
  if (!row) return null;
  const claim = parseReachKnock({ agentLabel: 'stored', ...JSON.parse(row.purpose) });
  if (!claim.ok) return null;
  const surface = reachBearerSurface(principalDid);
  await attestReachBearer('access.bearer.used', row.principal_did, row.id, { bearerId: row.id, surface });
  try {
    await publish('access.bearer.used', { issuer: await getNodeDid(), subject: row.principal_did, scope: 'access',
      payload: { bearerId: row.id, principalDid: row.principal_did, surface, context_id: row.id, context_type: 'access.bearer' } });
  } catch {
    log.error({ bearerId: row.id }, 'Reach credential use publication failed');
  }
  return { requesterDid: row.principal_did, bearerId: row.id, onBehalfOf: claim.input.onBehalfOf };
}

/** Metadata only: the plaintext and hash are never selected, including for Ryan. */
export async function listReachBearerKnocks(principalDid: string): Promise<ReachBearerKnock[]> {
  const rows = await getClient().unsafe<Array<{
    request_id: string; requester_did: string; agent_label: string; purpose: string;
    issued_at: Date; expires_at: Date; hard_cap_at: Date; status: string;
  }>>(`
    SELECT b.request_id, b.principal_did AS requester_did, b.client_label AS agent_label,
      b.purpose, b.issued_at, b.expires_at, b.hard_cap_at,
      CASE WHEN b.status = 'revoked' OR s.revoked_at IS NOT NULL THEN 'revoked'
        WHEN b.expires_at <= now() OR b.hard_cap_at <= now() THEN 'expired' ELSE b.status END AS status
    FROM auth.delegate_grant_bearers b JOIN auth.foreign_agent_stubs s ON s.stub_did = b.principal_did
    WHERE s.principal_did = $1 AND b.surfaces = $2::jsonb
    ORDER BY b.issued_at DESC, b.id DESC LIMIT 100
  `, [principalDid, JSON.stringify([reachBearerSurface(principalDid)])]);
  return rows.map(row => ({
    requestId: row.request_id, requesterDid: row.requester_did, principalDid, agentLabel: row.agent_label,
    onBehalfOf: JSON.parse(row.purpose).onBehalfOf, claimVerified: false,
    issuedAt: row.issued_at.toISOString(), expiresAt: row.expires_at.toISOString(),
    hardCapAt: row.hard_cap_at.toISOString(), status: row.status,
  }));
}

export async function blockReachBearerKnock(params: { principalDid: string; requestId: string }): Promise<boolean> {
  const [row] = await getClient().unsafe<Array<{ requester_did: string }>>(`
    SELECT b.principal_did AS requester_did FROM auth.delegate_grant_bearers b
    JOIN auth.foreign_agent_stubs s ON s.stub_did = b.principal_did
    WHERE b.request_id = $1 AND s.principal_did = $2 AND b.surfaces = $3::jsonb LIMIT 1
  `, [params.requestId, params.principalDid, JSON.stringify([reachBearerSurface(params.principalDid)])]);
  if (!row) return false;
  await blockForeignAgentStub(row.requester_did, params.principalDid);
  await blockReachSender({ principalDid: params.principalDid, requesterDid: row.requester_did });
  return true;
}
