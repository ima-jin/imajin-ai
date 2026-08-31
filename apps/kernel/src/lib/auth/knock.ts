/**
 * External-agent knock lifecycle (#1883) — the "knock, not registration"
 * onboarding path settled at the #1881 Day-1 review (2026-08-30). See
 * packages/auth/src/knock.ts for the client-safe shape/validation helpers
 * this module builds on.
 *
 * Composes with #1882 (delegation grants) rather than duplicating it: this
 * module never issues a grant — `issueGrant()` (grants.ts) is the *only*
 * path to authority, called separately by the accepting principal via
 * POST /auth/api/grants after `acceptKnock()` below has minted (or reused)
 * an identity. Composes with #1885 (attestations) for the
 * external-DID-as-attestation record.
 *
 * Invariants enforced here, not just documented:
 *   - No identity without a human touch: `submitKnock()` never inserts into
 *     `identities` — the escrowed public key lives only in `agent_knocks`
 *     until `acceptKnock()` runs, and only for the declared target's own
 *     accept action.
 *   - No stub-minting from knocks: `declared_target` must resolve to an
 *     existing principal or the knock is rejected outright.
 *   - Advisory means advisory: `requested_capabilities` are stored and
 *     returned for display, never consulted for authorization anywhere in
 *     this module.
 *   - Fail-closed: status only ever moves pending -> accepted | declined;
 *     expiry is a plain timestamp comparison at read/accept/decline time,
 *     never a background sweep into a stored 'expired' status.
 */
import { and, eq, gt } from 'drizzle-orm';
import { db, identities, agentKnocks, connections, attestations, type AgentKnockRow } from '@/src/db';
import { generateId } from '@/src/lib/kernel/id';
import { didFromPublicKey } from '@/src/lib/auth/crypto';
import { getNodeDid } from '@/src/lib/kernel/node-identity';
import { canonicalize, crypto as authCrypto, isDid } from '@imajin/auth';
import type { AttestationType } from '@imajin/auth';
import {
  isKnockPublicKey,
  isKnockRequestedCapabilities,
  isKnockSelfDescription,
  isKnockExternalDid,
  KNOCK_TTL,
} from '@imajin/auth';
import { computeCid } from '@imajin/cid';
import * as bus from '@imajin/bus';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

export interface LibError {
  error: string;
  status: number;
}

export interface KnockRecord {
  knockId: string;
  agentDid: string;
  declaredTarget: string;
  selfDescription: string | null;
  requestedCapabilities: string[];
  externalDid: string | null;
  status: 'pending' | 'accepted' | 'declined';
  expiresAt: string;
  createdAt: string;
}

function toRecord(row: AgentKnockRow): KnockRecord {
  return {
    knockId: row.id,
    agentDid: row.agentDid,
    declaredTarget: row.declaredTarget,
    selfDescription: row.selfDescription ?? null,
    requestedCapabilities: Array.isArray(row.requestedCapabilities) ? (row.requestedCapabilities as string[]) : [],
    externalDid: row.externalDid ?? null,
    status: row.status as KnockRecord['status'],
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Resolve `declared_target` (a DID or handle, per #1883's Day-1 review) to
 * an existing principal's DID. Returns null if it doesn't resolve — the
 * caller must reject the knock outright rather than stub-mint anything.
 */
export async function resolveDeclaredTarget(value: string): Promise<string | null> {
  const column = isDid(value) ? identities.id : identities.handle;
  const [row] = await db.select({ id: identities.id }).from(identities).where(eq(column, value)).limit(1);
  return row?.id ?? null;
}

export interface SubmitKnockInput {
  publicKey: unknown;
  declaredTarget: unknown;
  selfDescription: unknown;
  requestedCapabilities: unknown;
  externalDid?: unknown;
}

/**
 * Submit a knock. Idempotent for retries: a second knock from the same
 * keypair to the same still-pending target refreshes the existing row's
 * description/capabilities/expiry instead of piling up duplicates — a
 * basic, deliberately simple abuse guard (full rate/abuse mechanics are
 * out of scope; see the route layer for per-target/per-IP rate limiting).
 */
export async function submitKnock(input: SubmitKnockInput): Promise<{ knock: KnockRecord } | LibError> {
  if (!isKnockPublicKey(input.publicKey)) {
    return { error: 'publicKey must be a 64-character hex-encoded Ed25519 public key', status: 400 };
  }
  const publicKey = input.publicKey;

  if (typeof input.declaredTarget !== 'string' || !input.declaredTarget) {
    return { error: 'declared_target is required', status: 400 };
  }
  const targetDid = await resolveDeclaredTarget(input.declaredTarget);
  if (!targetDid) {
    // Day-1 review: "if it doesn't resolve, the knock is rejected. No
    // stub-minting from knocks in v1 (outside agents creating stubs is a
    // graph-pollution vector)."
    return { error: 'declared_target does not resolve to an existing principal', status: 404 };
  }

  if (!isKnockSelfDescription(input.selfDescription)) {
    return { error: 'self_description is required (non-empty, max 1000 characters)', status: 400 };
  }
  if (!isKnockRequestedCapabilities(input.requestedCapabilities)) {
    return { error: 'requested_capabilities must be an array of domain:verb strings (advisory only, max 20)', status: 400 };
  }

  let externalDid: string | null = null;
  if (input.externalDid !== undefined && input.externalDid !== null && input.externalDid !== '') {
    if (!isKnockExternalDid(input.externalDid)) {
      return { error: 'external_did must be a valid DID', status: 400 };
    }
    externalDid = input.externalDid;
  }

  const agentDid = didFromPublicKey(publicKey);
  if (agentDid === targetDid) {
    return { error: 'An identity cannot knock on itself', status: 400 };
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + KNOCK_TTL);

  const [existingPending] = await db
    .select({ id: agentKnocks.id })
    .from(agentKnocks)
    .where(
      and(
        eq(agentKnocks.publicKey, publicKey),
        eq(agentKnocks.declaredTarget, targetDid),
        eq(agentKnocks.status, 'pending'),
      ),
    )
    .limit(1);

  const knockId = existingPending?.id ?? generateId('knock');

  if (existingPending) {
    await db
      .update(agentKnocks)
      .set({
        selfDescription: input.selfDescription,
        requestedCapabilities: [...input.requestedCapabilities],
        externalDid,
        expiresAt,
      })
      .where(eq(agentKnocks.id, knockId));
  } else {
    await db.insert(agentKnocks).values({
      id: knockId,
      publicKey,
      agentDid,
      declaredTarget: targetDid,
      selfDescription: input.selfDescription,
      requestedCapabilities: [...input.requestedCapabilities],
      externalDid,
      status: 'pending',
      expiresAt,
      createdAt: now,
    });
  }

  const [row] = await db.select().from(agentKnocks).where(eq(agentKnocks.id, knockId)).limit(1);
  log.info({ knockId, agentDid, declaredTarget: targetDid }, existingPending ? 'Knock refreshed' : 'Knock submitted');
  return { knock: toRecord(row) };
}

/** List a target's pending, unexpired knocks — the review-surface list, newest first. */
export async function listPendingKnocksForTarget(targetDid: string): Promise<KnockRecord[]> {
  const rows = await db
    .select()
    .from(agentKnocks)
    .where(
      and(
        eq(agentKnocks.declaredTarget, targetDid),
        eq(agentKnocks.status, 'pending'),
        gt(agentKnocks.expiresAt, new Date()),
      ),
    );

  return rows
    .map(toRecord)
    .sort((a: KnockRecord, b: KnockRecord) => b.createdAt.localeCompare(a.createdAt));
}

export interface RespondToKnockParams {
  knockId: string;
  requestedBy: string;
}

async function loadPendingKnockForTarget(params: RespondToKnockParams): Promise<{ row: AgentKnockRow } | LibError> {
  const [row] = await db.select().from(agentKnocks).where(eq(agentKnocks.id, params.knockId)).limit(1);
  if (!row) return { error: 'Knock not found', status: 404 };
  if (row.declaredTarget !== params.requestedBy) {
    return { error: 'Only the declared target may respond to this knock', status: 403 };
  }
  if (row.status !== 'pending') {
    return { error: `Knock already ${row.status}`, status: 409 };
  }
  if (row.expiresAt.getTime() <= Date.now()) {
    return { error: 'Knock has expired', status: 409 };
  }
  return { row };
}

/** Decline discards the request outright — no identity was ever created, so there is nothing further to undo. */
export async function declineKnock(params: RespondToKnockParams): Promise<{ declined: true } | LibError> {
  const loaded = await loadPendingKnockForTarget(params);
  if ('error' in loaded) return loaded;

  await db
    .update(agentKnocks)
    .set({ status: 'declined', respondedAt: new Date() })
    .where(and(eq(agentKnocks.id, params.knockId), eq(agentKnocks.status, 'pending')));

  return { declined: true };
}

export interface AcceptKnockResult {
  agentDid: string;
  /** True only when this accept minted a brand-new identity (first accepted knock for this keypair). */
  minted: boolean;
}

/**
 * Accept: mint-on-accept, never on knock. Zero grants — this only creates
 * (or reuses) an identity and links it to the accepting principal via the
 * same `connections` primitive humans use. Authority is a separate,
 * strictly user-push act via POST /auth/api/grants (#1882), never bundled
 * into this call ("Accept must never be optimized into accept+grant").
 */
export async function acceptKnock(params: RespondToKnockParams): Promise<{ result: AcceptKnockResult } | LibError> {
  const loaded = await loadPendingKnockForTarget(params);
  if ('error' in loaded) return loaded;
  const knock = loaded.row;

  const [existingIdentity] = await db
    .select({ id: identities.id, publicKey: identities.publicKey })
    .from(identities)
    .where(eq(identities.id, knock.agentDid))
    .limit(1);

  let minted = false;
  if (existingIdentity) {
    // Multi-tenant reuse (Day-1 review: "the DID is minted once, on the
    // first accepted knock; subsequent knocks to new users reference the
    // existing DID"). did:imajin is derived deterministically from the
    // public key, so this branch can only be reached by the same keypair —
    // but never silently trust a mismatch if storage disagrees.
    if (existingIdentity.publicKey !== knock.publicKey) {
      log.error({ knockId: knock.id, agentDid: knock.agentDid }, 'Knock public key does not match existing identity — refusing to reuse');
      return { error: 'Stored agent identity does not match this knock\u2019s public key', status: 500 };
    }
  } else {
    await db.insert(identities).values({
      id: knock.agentDid,
      scope: 'actor',
      subtype: 'agent',
      publicKey: knock.publicKey,
      tier: 'preliminary',
      metadata: knock.selfDescription ? { selfDescription: knock.selfDescription, onboardedVia: 'knock' } : { onboardedVia: 'knock' },
    });
    minted = true;
  }

  // "Every agent identity is born from a principal relationship" — link via
  // the same connections primitive the human invite-accept flow uses
  // (register.ts autoAcceptInvite), not the coarse identity_members
  // role='agent' bootstrap: that confers X-Acting-For authority, and
  // accept-contact must stay zero-grant.
  const [connDidA, connDidB] = [params.requestedBy, knock.agentDid].sort((a: string, b: string) => a.localeCompare(b));
  await db
    .insert(connections)
    .values({ didA: connDidA, didB: connDidB })
    .onConflictDoUpdate({
      target: [connections.didA, connections.didB],
      set: { disconnectedAt: null, connectedAt: new Date() },
    });

  await db
    .update(agentKnocks)
    .set({ status: 'accepted', respondedAt: new Date() })
    .where(and(eq(agentKnocks.id, params.knockId), eq(agentKnocks.status, 'pending')));

  if (minted) {
    bus.publish('identity.created', {
      issuer: knock.agentDid,
      subject: knock.agentDid,
      scope: 'auth',
      payload: { tier: 'preliminary', scope: 'actor', subtype: 'agent', context_id: knock.agentDid, context_type: 'identity' },
    }).catch((err: unknown) => log.error({ err: String(err) }, '[knock] identity.created publish failed'));
  }

  bus.publish('connection.accepted', {
    issuer: knock.agentDid,
    subject: params.requestedBy,
    scope: 'connections',
    payload: {
      context_id: knock.id,
      context_type: 'agent_knock',
      name: knock.selfDescription ?? knock.agentDid.slice(0, 16),
    },
  }).catch((err: unknown) => log.error({ err: String(err) }, '[knock] connection.accepted publish failed'));

  if (knock.externalDid) {
    await emitExternalIdentityAttestation({ agentDid: knock.agentDid, externalDid: knock.externalDid }).catch((err: unknown) =>
      log.error({ err: String(err), agentDid: knock.agentDid }, '[knock] external-identity attestation failed'),
    );
  }

  log.info({ knockId: knock.id, agentDid: knock.agentDid, target: params.requestedBy, minted }, 'Knock accepted');
  return { result: { agentDid: knock.agentDid, minted } };
}

function genAttestationId(): string {
  return generateId('att');
}

/**
 * Record a knock's optional bring-your-own external DID as a mechanical,
 * platform-authored attestation ("this imajin identity is operated by
 * did:web:boardy.ai") — linkage only, never the auth basis (mirrors
 * `emitSessionAttestation`'s direct-insert + node-signature pattern).
 */
async function emitExternalIdentityAttestation(params: { agentDid: string; externalDid: string }): Promise<void> {
  const privateKey = process.env.AUTH_PRIVATE_KEY;
  if (!privateKey) {
    log.warn({}, 'external-identity attestation skipped: AUTH_PRIVATE_KEY not set');
    return;
  }
  const platformDid = await getNodeDid();
  if (!platformDid) {
    log.warn({}, 'external-identity attestation skipped: node DID not set');
    return;
  }

  const issuedAtMs = Date.now();
  const payload = { external_did: params.externalDid };

  const canonicalPayload = canonicalize({
    subject_did: params.agentDid,
    type: 'agent.external_identity',
    context_id: null,
    context_type: 'auth',
    payload,
    issued_at: issuedAtMs,
  });
  const signature = authCrypto.signSync(canonicalPayload, privateKey);

  let cid: string | null = null;
  try {
    cid = await computeCid({
      issuerDid: platformDid,
      subjectDid: params.agentDid,
      type: 'agent.external_identity',
      contextId: null,
      contextType: 'auth',
      payload,
      issuedAt: issuedAtMs,
    });
  } catch {
    // Non-fatal — old-style attestation still works without CID.
  }

  await db.insert(attestations).values({
    id: genAttestationId(),
    issuerDid: platformDid,
    subjectDid: params.agentDid,
    type: 'agent.external_identity' as AttestationType,
    contextId: null,
    contextType: 'auth',
    payload,
    signature,
    cid,
    // Mechanical record, not a bilateral claim awaiting countersignature —
    // same convention as emitSessionAttestation's session.created rows.
    attestationStatus: null,
    issuedAt: new Date(issuedAtMs),
  });
}
