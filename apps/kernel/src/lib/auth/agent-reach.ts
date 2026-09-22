/**
 * Per-principal agent-reach gate (#2251) — a foreign agent, acting for its
 * own principal, asks a specific human's agent a single question under a
 * principal-authored gate, both sides signed.
 *
 * This module composes five existing, unmodified primitives rather than
 * inventing new ones (see the #2251 Phase 1 seam-proposal comment for the
 * full reasoning):
 *   1. Delegation grants (#1882, ./grants.ts) — `introspectGrant()` decides
 *      whether the requesting agent DID may reach this principal at all.
 *      Fails closed: a revoked grant makes the very next call deny.
 *   2. The foreign-principal stub (#2251, ./foreign-principal-stub.ts) — a
 *      generalization of the email-keyed claimable-stub primitive (#1834)
 *      for the human the foreign agent claims to act for.
 *   3. The broker/consent pipeline (#1048/#1049/#1514, `@imajin/bus`) — the
 *      actual match-without-disclosure gate. `kernel.consent_grants` is the
 *      principal-authored policy; `broker()` evaluates it and returns only a
 *      boolean, never the underlying value.
 *   4. Signature verification (./crypto.ts) — the same Ed25519
 *      verify/derive primitives challenge-response auth already uses.
 *   5. Attestations (`@imajin/auth`) — the mechanical, kernel-signed record
 *      binding both DIDs and the transcript hash.
 */
import { eq, and } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { db, identities, consentGrants } from '@/src/db';
import { canonicalize, emitAttestation } from '@imajin/auth';
import { broker, publish, isBrokerRelease } from '@imajin/bus';
import type { BrokerPredicateClaim } from '@imajin/bus';
import { createLogger } from '@imajin/logger';
import { verifySignature } from './crypto';
import { introspectGrant } from './grants';
import { resolveOrMintForeignPrincipalStub } from './foreign-principal-stub';
import { getNodeDid } from '@/src/lib/kernel/node-identity';
import { generateId } from '@/src/lib/kernel/id';

const log = createLogger('kernel');

/** Closed-vocabulary capability this slice's gate requires (packages/auth/src/grant-scopes.ts). */
export const AGENT_REACH_CAPABILITY = 'agent:reach';

export interface ReachOnBehalfOf {
  /** The foreign agent's own platform, e.g. 'meta-muse'. Never ours. */
  platform: string;
  /** Opaque, platform-scoped reference for the human the agent acts for. Never an email or other PII. */
  externalRef: string;
  /** Self-description only — recorded, never verified (see Phase 1 DECISION FOR RYAN). */
  selfDescription?: string;
}

export interface ReachRequestInput {
  requesterDid: string;
  onBehalfOf: ReachOnBehalfOf;
  purpose: string;
  field: string;
  predicate: 'contains' | 'overlaps' | 'is_empty' | 'eq' | 'gte' | 'lte';
  arg?: unknown;
  issuedAt: string;
  /** Hex Ed25519 signature over {@link reachTranscript} of every other field, by the requester's registered key. */
  signature: string;
}

export type ReachDenialReason = 'invalid_signature' | 'unauthorized' | 'principal_not_found' | 'requester_unknown';

export interface ReachAnswer {
  answer: boolean;
  transcriptHash: string;
  issuedAt: string;
}

export interface ReachDenied {
  denied: true;
  reason: ReachDenialReason;
  status: number;
}

/**
 * The canonical transcript the requester signs and both records hash.
 * Deliberately excludes `signature` itself (nothing signs its own signature)
 * and includes `principalDid` so a signature over one principal cannot be
 * replayed against another.
 */
export function reachTranscript(principalDid: string, input: Omit<ReachRequestInput, 'signature'>): string {
  return canonicalize({
    principalDid,
    requesterDid: input.requesterDid,
    onBehalfOf: input.onBehalfOf,
    purpose: input.purpose,
    field: input.field,
    predicate: input.predicate,
    arg: input.arg ?? null,
    issuedAt: input.issuedAt,
  });
}

function hashTranscript(transcript: string): string {
  return createHash('sha256').update(transcript).digest('hex');
}

async function publishDenied(params: { requesterDid: string; principalDid: string; reason: ReachDenialReason }): Promise<void> {
  await publish('agent.reach.denied', {
    issuer: params.requesterDid,
    subject: params.principalDid,
    scope: 'agent',
    payload: {
      requesterDid: params.requesterDid,
      principalDid: params.principalDid,
      reason: params.reason,
      context_id: params.requesterDid,
      context_type: 'agent.reach',
    },
  }).catch((err: unknown) => log.error({ err: String(err) }, '[agent-reach] agent.reach.denied publish failed'));
}

function denial(reason: ReachDenialReason, status: number): ReachDenied {
  return { denied: true, reason, status };
}

/** Extract the single predicate claim's boolean result from a broker release, or false if absent/malformed. */
function extractAnswer(data: Record<string, unknown>, field: string): boolean {
  const value = data[field];
  const claim = Array.isArray(value) ? (value[0] as BrokerPredicateClaim | undefined) : (value as BrokerPredicateClaim | undefined);
  return claim?.result === true;
}

/**
 * Evaluate one reach request against `principalDid`'s gate. Fails closed at
 * every step: an unknown principal, an unknown/unsigned-for requester, an
 * invalid signature, or a missing/revoked `agent:reach` grant all deny
 * before the gate is ever evaluated. A gate with no configured
 * `consent_grants` row also denies (via the broker's own fail-closed
 * default) — collapsed into the same `answer: false` as a gate that
 * evaluated and declined, so the absence of a gate is never itself
 * disclosed to the requester.
 */
export async function reachPrincipal(
  principalDid: string,
  input: ReachRequestInput,
): Promise<ReachAnswer | ReachDenied> {
  const [principal] = await db
    .select({ id: identities.id, metadata: identities.metadata })
    .from(identities)
    .where(eq(identities.id, principalDid))
    .limit(1);
  if (!principal) {
    await publishDenied({ requesterDid: input.requesterDid, principalDid, reason: 'principal_not_found' });
    return denial('principal_not_found', 404);
  }

  const [requester] = await db
    .select({ id: identities.id, publicKey: identities.publicKey })
    .from(identities)
    .where(eq(identities.id, input.requesterDid))
    .limit(1);
  if (!requester) {
    await publishDenied({ requesterDid: input.requesterDid, principalDid, reason: 'requester_unknown' });
    return denial('requester_unknown', 401);
  }

  const transcript = reachTranscript(principalDid, input);
  const signatureValid = await verifySignature(transcript, input.signature, requester.publicKey);
  if (!signatureValid) {
    await publishDenied({ requesterDid: input.requesterDid, principalDid, reason: 'invalid_signature' });
    return denial('invalid_signature', 401);
  }

  const introspection = await introspectGrant({
    agentDid: input.requesterDid,
    capability: AGENT_REACH_CAPABILITY,
    targetDid: principalDid,
    delegatorDid: principalDid,
  });
  if (!introspection.authorized || !introspection.grantId) {
    await publishDenied({ requesterDid: input.requesterDid, principalDid, reason: 'unauthorized' });
    return denial('unauthorized', 403);
  }

  const stub = await resolveOrMintForeignPrincipalStub({
    platform: input.onBehalfOf.platform,
    externalRef: input.onBehalfOf.externalRef,
  });

  const metadata = (principal.metadata ?? {}) as Record<string, unknown>;
  const rawGateValue = Array.isArray(metadata.agentReachTopics) ? metadata.agentReachTopics : [];

  const brokerResult = await broker(input.purpose, {
    type: input.purpose,
    requester: input.requesterDid,
    subject: principalDid,
    fields: [input.field],
    purpose: input.purpose,
    scope: 'agent',
    data: { [input.field]: rawGateValue },
    predicates: { [input.field]: { predicate: input.predicate, arg: input.arg } },
  });

  const answer = isBrokerRelease(brokerResult) ? extractAnswer(brokerResult.data, input.field) : false;
  const transcriptHash = hashTranscript(transcript);
  const issuedAt = new Date().toISOString();

  const nodeDid = await getNodeDid();
  await emitAttestation({
    issuer_did: nodeDid,
    subject_did: principalDid,
    type: 'agent.reach',
    context_id: input.requesterDid,
    context_type: 'agent.reach',
    payload: {
      requesterDid: input.requesterDid,
      onBehalfOfStubDid: stub.did,
      onBehalfOfPlatform: input.onBehalfOf.platform,
      selfDescription: input.onBehalfOf.selfDescription ?? null,
      principalDid,
      purpose: input.purpose,
      field: input.field,
      predicate: input.predicate,
      arg: input.arg ?? null,
      answer,
      transcriptHash,
      requesterSignature: input.signature,
      grantId: introspection.grantId,
    },
  }).catch((err: unknown) => log.error({ err: String(err) }, '[agent-reach] emitAttestation failed'));

  await publish('agent.reach.answered', {
    issuer: input.requesterDid,
    subject: principalDid,
    scope: 'agent',
    payload: {
      requesterDid: input.requesterDid,
      principalDid,
      onBehalfOfStubDid: stub.did,
      purpose: input.purpose,
      field: input.field,
      answer,
      grantId: introspection.grantId,
      context_id: input.requesterDid,
      context_type: 'agent.reach',
    },
  }).catch((err: unknown) => log.error({ err: String(err) }, '[agent-reach] agent.reach.answered publish failed'));

  return { answer, transcriptHash, issuedAt };
}

/**
 * Idempotent dev/seed helper (#2251 "one seeded example for the dev
 * principal"): merges `topics` into the principal's own
 * `identities.metadata.agentReachTopics` (the raw, never-disclosed gate
 * value) and ensures exactly one `kernel.consent_grants` row exists opening
 * the `agent.reach` / `contact_topics` gate to any requester holding a valid
 * `agent:reach` grant (`grantedToClass: 'strangers'` — #1189's "any
 * requester, no ring check" class).
 *
 * Not wired into a SQL migration deliberately: the principal's DID is a
 * runtime value (minted via key ceremony), never a fixed string a migration
 * could hardcode.
 */
export async function seedAgentReachGate(params: { principalDid: string; topics: string[] }): Promise<void> {
  const [principal] = await db
    .select({ id: identities.id, metadata: identities.metadata })
    .from(identities)
    .where(eq(identities.id, params.principalDid))
    .limit(1);
  if (!principal) {
    throw new Error(`seedAgentReachGate: principal ${params.principalDid} not found`);
  }

  const metadata = (principal.metadata ?? {}) as Record<string, unknown>;
  await db
    .update(identities)
    .set({ metadata: { ...metadata, agentReachTopics: params.topics } })
    .where(eq(identities.id, params.principalDid));

  const [existingGrant] = await db
    .select({ id: consentGrants.id })
    .from(consentGrants)
    .where(
      and(
        eq(consentGrants.subject, params.principalDid),
        eq(consentGrants.purpose, 'agent.reach'),
        eq(consentGrants.grantedToClass, 'strangers'),
        eq(consentGrants.status, 'active'),
      ),
    )
    .limit(1);

  if (!existingGrant) {
    await db.insert(consentGrants).values({
      id: generateId('cgrant'),
      subject: params.principalDid,
      grantedToClass: 'strangers',
      purpose: 'agent.reach',
      allowedFields: ['contact_topics'],
      mode: 'attestation',
      status: 'active',
      consentRef: generateId('consent'),
    });
  }
}
