/**
 * Per-principal agent-reach gate (#2251) — a foreign agent, acting for its
 * own principal, asks a specific human's agent a single question under a
 * principal-authored gate, both sides signed.
 *
 * This module composes five existing, unmodified primitives rather than
 * inventing new ones (see the #2251 Phase 1 seam-proposal comment for the
 * full reasoning):
 *   1. Reach authority (#2590, ./reach-authority.ts) — an explicit grant or
 *      the principal's tier gate admits a verified caller. Sender blocks
 *      revoke scoped stub credentials on the very next call.
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
import { canonicalize, emitAttestation, SIGNED_MESSAGE_MAX_AGE, FUTURE_TOLERANCE } from '@imajin/auth';
import { broker, publish, isBrokerRelease } from '@imajin/bus';
import type { BrokerPredicateClaim } from '@imajin/bus';
import { createLogger } from '@imajin/logger';
import { verifySignature } from './crypto';
import { resolveReachRequester, authorizeReachRequester } from './reach-authority';
import { resolveOrMintForeignPrincipalStub, type ForeignPrincipalStubResult } from './foreign-principal-stub';
import { getNodeDid } from '@/src/lib/kernel/node-identity';
import { generateId } from '@/src/lib/kernel/id';
import type { ReachDeliveryInput } from './reach-delivery-input';
import { parseReachDelivery } from './reach-delivery-input';
import { deliverReach } from './reach-delivery';
import { markReachPublished } from './reach-envelope-store';
import { resolveReachBearer } from '@/src/lib/access/reach-bearer';
import { isTierAdmitted } from '@/src/lib/jin/front-door';
import { auditReachThrottle, guardReachRequester, reachDailyRetryAfter, reachInputTooLarge } from './reach-abuse-guard';
import { isReachSenderBlocked } from './reach-block';

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

export interface ReachRequestInput extends Partial<ReachDeliveryInput> {
  requesterDid: string;
  /** did:web callers supply the key that must be verified against their DID document. */
  publicKey?: string;
  onBehalfOf: ReachOnBehalfOf;
  purpose: string;
  field: string;
  predicate: 'contains' | 'overlaps' | 'is_empty' | 'eq' | 'gte' | 'lte';
  arg?: unknown;
  issuedAt: string;
  /** Hex Ed25519 signature over {@link reachTranscript} of every other field, by the requester's registered key. */
  signature: string;
}

export type ReachDenialReason = 'invalid_signature' | 'unauthorized' | 'principal_not_found' | 'requester_unknown' | 'rate_limited';

export interface ReachAnswer {
  answer: boolean;
  transcriptHash: string;
  issuedAt: string;
}

export interface ReachDenied {
  denied: true;
  reason: ReachDenialReason | 'body_too_large';
  status: number;
  retryAfter?: number;
}

export interface ReachDelivered {
  delivered: true;
  reachId: string;
}
export type ReachResult = ReachAnswer | ReachDenied | ReachDelivered;

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
    // Omit entirely for legacy asks: existing signatures remain valid.
    ...(input.message === undefined && input.topic === undefined && input.replyHandle === undefined
      ? {} : { message: input.message ?? null, topic: input.topic ?? null, replyHandle: input.replyHandle ?? null }),
  });
}

function hashTranscript(transcript: string): string {
  return createHash('sha256').update(transcript).digest('hex');
}

/**
 * Bounds the requester-claimed `issuedAt` the same way
 * `apps/kernel/src/lib/notify/operator-approvals-service.ts`'s
 * `isDecidedAtWithinClockSkew` bounds a claimed decision timestamp —
 * reusing `SIGNED_MESSAGE_MAX_AGE`/`FUTURE_TOLERANCE` rather than inventing
 * new constants (or a nonce store) for what is, structurally, the same
 * clock-skew/replay-window problem (owner ruling on #2251 review, 2026-09-22).
 * A stale or future-dated request is folded into the same `invalid_signature`
 * / 401 outcome as a cryptographically bad signature — the anti-enumeration
 * property already established for that path: a requester cannot tell "your
 * clock is off" apart from "your key is wrong" from the response alone.
 */
function isReachRequestFresh(issuedAt: string): boolean {
  const claimed = Date.parse(issuedAt);
  if (Number.isNaN(claimed)) return false;
  const age = Date.now() - claimed;
  return age <= SIGNED_MESSAGE_MAX_AGE && age >= -FUTURE_TOLERANCE;
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

function denial(reason: ReachDenied['reason'], status: number): ReachDenied {
  return { denied: true, reason, status };
}

/** Extract the single predicate claim's boolean result from a broker release, or false if absent/malformed. */
function extractAnswer(data: Record<string, unknown>, field: string): boolean {
  const value = data[field];
  const claim = Array.isArray(value) ? (value[0] as BrokerPredicateClaim | undefined) : (value as BrokerPredicateClaim | undefined);
  return claim?.result === true;
}

interface EmitReachAttestationParams {
  principalDid: string;
  input: ReachRequestInput;
  transcriptHash: string;
  signatureVerified: boolean;
  outcome: 'answered' | 'denied';
  reason?: ReachDenialReason;
  answer?: boolean;
  onBehalfOfStubDid?: string;
  grantId?: string;
}

/**
 * Mint exactly one `agent.reach` attestation for this exchange, whatever the
 * outcome (owner ruling on #2251 review, 2026-09-22: "every reach exchange —
 * answered OR denied by the gate — mints exactly one attestation... the
 * record remembers THAT a reach was refused; the boolean leaks nothing").
 * Binds the transcript hash, never the transcript bytes themselves — the
 * payload below carries only the structured request metadata (purpose,
 * field, predicate, declared arg) that the requester already disclosed by
 * making the call, plus the boolean answer only on the `answered` branch.
 * `signatureVerified` is carried explicitly so the record is honest about
 * what was actually checked: a denial minted before signature verification
 * (unknown principal/requester) or after a failed verification never claims
 * the requester's identity was authenticated.
 */
async function emitReachAttestation(params: EmitReachAttestationParams): Promise<void> {
  const { input } = params;
  const nodeDid = await getNodeDid();
  await emitAttestation({
    issuer_did: nodeDid,
    subject_did: params.principalDid,
    type: 'agent.reach',
    context_id: input.requesterDid,
    context_type: 'agent.reach',
    payload: {
      requesterDid: input.requesterDid,
      principalDid: params.principalDid,
      onBehalfOfStubDid: params.onBehalfOfStubDid ?? null,
      onBehalfOfPlatform: input.onBehalfOf.platform,
      selfDescription: input.onBehalfOf.selfDescription ?? null,
      claimVerified: false,
      purpose: input.purpose,
      field: input.field,
      predicate: input.predicate,
      arg: input.arg ?? null,
      transcriptHash: params.transcriptHash,
      requesterSignature: input.signature,
      signatureVerified: params.signatureVerified,
      grantId: params.grantId ?? null,
      outcome: params.outcome,
      ...(params.outcome === 'denied' ? { reason: params.reason } : { answer: params.answer }),
    },
  }).catch((err: unknown) => log.error({ err: String(err), outcome: params.outcome }, '[agent-reach] emitAttestation failed'));
}

/** Attest the denial, then publish `agent.reach.denied` — every fail-closed exit uses this single path. */
async function denyReach(params: {
  principalDid: string;
  input: ReachRequestInput;
  transcriptHash: string;
  reason: ReachDenialReason;
  signatureVerified: boolean;
}): Promise<void> {
  await emitReachAttestation({
    principalDid: params.principalDid,
    input: params.input,
    transcriptHash: params.transcriptHash,
    signatureVerified: params.signatureVerified,
    outcome: 'denied',
    reason: params.reason,
  });
  await publishDenied({ requesterDid: params.input.requesterDid, principalDid: params.principalDid, reason: params.reason });
}

async function completeDelivery(params: Parameters<typeof deliverReach>[0]): Promise<ReachDelivered | ReachDenied | null> {
  const { principalDid, input, transcriptHash } = params;
  const result = await deliverReach(params);
  if (result.outcome === 'declined') return null;
  if (result.outcome !== 'delivered') {
    const reason = result.outcome === 'blocked' ? 'unauthorized' : 'rate_limited';
    if (reason === 'rate_limited') {
      const retryAfter = reachDailyRetryAfter();
      await auditReachThrottle({ principalDid, requesterDid: input.requesterDid }, 'daily', principalDid, retryAfter);
      return { ...denial(reason, 429), retryAfter };
    }
    await denyReach({ principalDid, input, transcriptHash, reason, signatureVerified: params.requesterAuthTier !== 'bearer' });
    return denial(reason, result.outcome === 'blocked' ? 403 : 429);
  }
  // The attestation committed with the envelope, so publication retries can
  // never mint a second one. Reuse the original signed event on retries.
  if (!result.published) {
    await publish('agent.reach.delivered', result.event);
    await markReachPublished({ principalDid, reachId: result.reachId });
  }
  return { delivered: true, reachId: result.reachId };
}

/**
 * Evaluate one reach request against `principalDid`'s gate. Fails closed at
 * every step: an unknown principal, an unknown/unsigned-for requester, a
 * stale/future/invalid signature, a sender block, or neither a valid grant
 * nor an admitted credential tier deny before the broker is evaluated. Those
 * denials, like every answered exchange, mints exactly one `agent.reach`
 * attestation (see {@link emitReachAttestation}). A gate with no configured
 * `consent_grants` row also denies (via the broker's own fail-closed
 * default) — collapsed into the same `answer: false` as a gate that
 * evaluated and declined, so the absence of a gate is never itself
 * disclosed to the requester.
 */
export async function reachPrincipal(
  principalDid: string,
  input: ReachRequestInput,
): Promise<ReachResult> {
  if (reachInputTooLarge(input)) return denial('body_too_large', 413);
  const transcript = reachTranscript(principalDid, input);
  const transcriptHash = hashTranscript(transcript);

  const [principal] = await db
    .select({ id: identities.id, metadata: identities.metadata })
    .from(identities)
    .where(eq(identities.id, principalDid))
    .limit(1);
  if (!principal) {
    await denyReach({ principalDid, input, transcriptHash, reason: 'principal_not_found', signatureVerified: false });
    return denial('principal_not_found', 404);
  }

  const requester = await resolveReachRequester(input.requesterDid, input.publicKey);
  if (!requester) {
    await denyReach({ principalDid, input, transcriptHash, reason: 'requester_unknown', signatureVerified: false });
    return denial('requester_unknown', 401);
  }

  if (!isReachRequestFresh(input.issuedAt)) {
    await denyReach({ principalDid, input, transcriptHash, reason: 'invalid_signature', signatureVerified: false });
    return denial('invalid_signature', 401);
  }

  const signatureValid = await verifySignature(transcript, input.signature, requester.publicKey);
  if (!signatureValid) {
    await denyReach({ principalDid, input, transcriptHash, reason: 'invalid_signature', signatureVerified: false });
    return denial('invalid_signature', 401);
  }

  const introspection = await authorizeReachRequester({
    requesterDid: input.requesterDid,
    principalDid,
    metadata: principal.metadata,
    tier: requester.tier,
    publicKey: requester.publicKey,
    purpose: input.purpose,
    field: input.field,
  });
  if (!introspection.authorized) {
    await denyReach({ principalDid, input, transcriptHash, reason: 'unauthorized', signatureVerified: true });
    return denial('unauthorized', 403);
  }

  return evaluateReach({ principalDid, input, principal, requester, introspection, transcriptHash, signatureVerified: true });
}

/** Possession authenticates THEIR stub, never the recipient or the claimed human. */
export async function reachPrincipalWithBearer(
  principalDid: string, token: string, body: Record<string, unknown>,
): Promise<ReachAnswer | ReachDenied | ReachDelivered> {
  if (reachInputTooLarge(body)) return denial('body_too_large', 413);
  const credential = await resolveReachBearer(token, principalDid);
  if (!credential) return denial('unauthorized', 401);
  return reachPrincipalWithCredential(principalDid, credential, body);
}

/** Transport adapters pass only a live, audience-verified reach credential. */
export async function reachPrincipalWithCredential(
  principalDid: string,
  credential: NonNullable<Awaited<ReturnType<typeof resolveReachBearer>>>,
  body: Record<string, unknown>,
): Promise<ReachResult> {
  const [principal] = await db.select({ id: identities.id, metadata: identities.metadata })
    .from(identities).where(eq(identities.id, principalDid)).limit(1);
  const metadata = principal?.metadata as Record<string, unknown> | null;
  if (!principal || !metadata || !Object.hasOwn(metadata, 'agentReachGate') || !isTierAdmitted(metadata, 'soft')) {
    return denial('unauthorized', 403);
  }
  const topic = body.topic ?? body.arg;
  if (typeof topic !== 'string' || !topic.trim() || topic.length > 200
    || (body.purpose !== undefined && body.purpose !== 'agent.reach')
    || (body.field !== undefined && body.field !== 'contact_topics')
    || (body.predicate !== undefined && body.predicate !== 'contains')
    || (body.arg !== undefined && body.arg !== topic)
    || (body.requesterDid !== undefined && body.requesterDid !== credential.requesterDid)) {
    return denial('unauthorized', 403);
  }
  const input: ReachRequestInput = {
    requesterDid: credential.requesterDid, onBehalfOf: credential.onBehalfOf,
    purpose: 'agent.reach', field: 'contact_topics', predicate: 'contains', arg: topic,
    issuedAt: typeof body.issuedAt === 'string' ? body.issuedAt : new Date().toISOString(), signature: '',
  };
  const delivery = parseReachDelivery({ ...body, ...input });
  if (!delivery.ok) return denial('unauthorized', 400);
  Object.assign(input, delivery.delivery);
  return evaluateReach({
    principalDid, input, principal, requester: { tier: 'soft' }, introspection: { stubDid: credential.requesterDid },
    transcriptHash: hashTranscript(reachTranscript(principalDid, input)), signatureVerified: false,
  });
}

async function prepareReachClaim(params: {
  principalDid: string; input: ReachRequestInput; publicKey?: string;
  agentStubDid: string; tier: unknown; transcriptHash: string; signatureVerified: boolean;
}): Promise<ReachDenied | ForeignPrincipalStubResult> {
  const { principalDid, input, transcriptHash, signatureVerified } = params;
  const throttled = await guardReachRequester({
    principalDid, requesterDid: input.requesterDid, agentStubDid: params.agentStubDid,
    onBehalfOf: input.onBehalfOf, tier: params.tier,
  });
  if (throttled) return throttled;
  const stub = await resolveOrMintForeignPrincipalStub({
    platform: input.onBehalfOf.platform, externalRef: input.onBehalfOf.externalRef,
  });
  if (await isReachSenderBlocked({
    principalDid, requesterDid: input.requesterDid, publicKey: params.publicKey, onBehalfOfStubDid: stub.did,
  })) {
    await denyReach({ principalDid, input, transcriptHash, reason: 'unauthorized', signatureVerified });
    return denial('unauthorized', 403);
  }
  return stub;
}

/** Both transports must pass the same abuse, broker, topic and delivery policy. */
async function evaluateReach(params: {
  principalDid: string;
  input: ReachRequestInput;
  principal: { metadata: unknown };
  requester: { tier: unknown; publicKey?: string };
  introspection: { grantId?: string; stubDid?: string };
  transcriptHash: string;
  signatureVerified: boolean;
}): Promise<ReachResult> {
  const { principalDid, input, principal, requester, introspection, transcriptHash, signatureVerified } = params;
  const stub = await prepareReachClaim({
    principalDid, input, publicKey: requester.publicKey, transcriptHash, signatureVerified,
    agentStubDid: introspection.stubDid ?? requester.publicKey ?? input.requesterDid, tier: requester.tier,
  });
  if ('denied' in stub) return stub;

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

  let answer = isBrokerRelease(brokerResult) ? extractAnswer(brokerResult.data, input.field) : false;
  const issuedAt = new Date().toISOString();
  const delivery = parseReachDelivery(input as unknown as Record<string, unknown>);
  if (!delivery.ok) {
    await denyReach({ principalDid, input, transcriptHash, reason: 'unauthorized', signatureVerified });
    return denial('unauthorized', 403);
  }
  if (delivery.delivery) {
    const result = await completeDelivery({
      principalDid, input: { ...input, ...delivery.delivery }, metadata: principal.metadata,
      requesterTier: typeof requester.tier === 'string' ? requester.tier : 'unknown', onBehalfOfStubDid: stub.did,
      grantId: introspection.grantId ?? null, transcriptHash, admitted: answer,
      requesterAuthTier: signatureVerified ? 'signed' : 'bearer',
    });
    if (result) return result;
    answer = false;
  }

  await emitReachAttestation({
    principalDid,
    input,
    transcriptHash,
    signatureVerified,
    outcome: 'answered',
    answer,
    onBehalfOfStubDid: stub.did,
    grantId: introspection.grantId,
  });

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
      grantId: introspection.grantId ?? null,
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
 * the `agent.reach` / `contact_topics` broker gate. This legacy seed still
 * needs an explicit grant; operator-authored tier admission comes from the
 * front door (`grantedToClass: 'strangers'` — #1189's "any
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
