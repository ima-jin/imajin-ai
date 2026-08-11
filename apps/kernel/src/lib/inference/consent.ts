/**
 * Consent-tier resolution (#1214, consumes #1196).
 *
 * Maps the top-ranked CandidateIntent to its consent tier and gates
 * accordingly — this is what keeps inference honest instead of surveillance.
 *
 *   silent    → update session status to 'resolving', return 'proceed'.
 *   itemized  → treat as deliberate for v1 (explicit confirm required).
 *   deliberate → update session to 'pending_confirm', return 'pending_confirm'.
 *
 * Never executes a boundary-crossing action without an explicit confirm from
 * the human. The AgriFortress one-confirm tap IS this gate.
 */

import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, inferenceSessions } from '@/src/db';
import { createLogger } from '@imajin/logger';
import { canonicalize, crypto as authCrypto } from '@imajin/auth';
import { getNodeSigningIdentity } from '@/src/lib/vault/sealing';
import type { CandidateIntent } from './types';

const log = createLogger('kernel:inference:consent');

export type ConsentGateOutcome = 'proceed' | 'pending_confirm';

/**
 * Resolve the consent gate for the chosen intent.
 *
 * - 'proceed'         → caller may immediately call resolveIntent().
 * - 'pending_confirm' → caller must surface a confirmation UI and wait for the
 *                       human to POST /api/inference/confirm/[sessionId].
 */
export async function resolveConsentGate(
  sessionId: string,
  intent: CandidateIntent,
): Promise<ConsentGateOutcome> {
  const tier = intent.consentTier;

  if (tier === 'silent') {
    // Read-your-own — may resolve quietly.
    await db
      .update(inferenceSessions)
      .set({
        chosenIntentType: intent.intentType,
        consentTier: tier,
        status: 'resolving',
        updatedAt: new Date(),
      })
      .where(eq(inferenceSessions.id, sessionId));

    log.info({ sessionId, intentType: intent.intentType, tier }, 'silent gate: proceeding');
    return 'proceed';
  }

  // deliberate or itemized (treated as deliberate in v1) — must confirm first.
  await db
    .update(inferenceSessions)
    .set({
      chosenIntentType: intent.intentType,
      consentTier: tier,
      status: 'pending_confirm',
      updatedAt: new Date(),
    })
    .where(eq(inferenceSessions.id, sessionId));

  log.info(
    { sessionId, intentType: intent.intentType, tier },
    'deliberate gate: awaiting human confirm',
  );
  return 'pending_confirm';
}

/**
 * Advance a session from 'pending_confirm' to 'resolving' after the human has
 * provided explicit confirmation. Called by the confirm API route.
 *
 * Throws if the session is not in 'pending_confirm' state or belongs to a
 * different owner — prevents replay and ownership confusion.
 *
 * @param confirmedMetadata - Optional human-edited/confirmed metadata (#1789).
 *   When provided, it is (a) folded into the signed owner authorization
 *   payload — the confirm tap IS the signing event, so what the human edited
 *   must be part of what gets signed here — and (b) persisted on the session
 *   as `confirmedMetadata`, distinct from `candidateIntents`, which always
 *   keeps the original inferred payload untouched. Omit (or pass undefined)
 *   for the no-body / backward-compatible path: confirms the inferred
 *   payload as-is.
 */
export async function confirmIntent(
  sessionId: string,
  ownerDid: string,
  confirmedMetadata?: Record<string, unknown>,
): Promise<void> {
  const [session] = await db
    .select()
    .from(inferenceSessions)
    .where(eq(inferenceSessions.id, sessionId))
    .limit(1);

  if (!session) throw new Error(`Session ${sessionId} not found`);
  if (session.ownerDid !== ownerDid) throw new Error('Session owner mismatch');
  if (session.status !== 'pending_confirm') {
    throw new Error(`Session is not awaiting confirmation (status: ${session.status})`);
  }

  // Build and sign the owner authorization.
  // The node acts for the owner and signs what was authorized so the confirm
  // tap is provably bound to the exact candidate set that was inferred, AND
  // (#1789) to the exact edited payload the human confirmed, when there is one.
  const identity = getNodeSigningIdentity();
  const ts = new Date().toISOString();
  const candidateDigest = createHash('sha256')
    .update(JSON.stringify(session.candidateIntents ?? []))
    .digest('hex');
  const confirmedMetadataDigest = confirmedMetadata !== undefined
    ? createHash('sha256').update(JSON.stringify(confirmedMetadata)).digest('hex')
    : null;
  const authPayload = {
    sessionId,
    chosenIntentType: session.chosenIntentType ?? '',
    candidateDigest,
    confirmedMetadataDigest,
    ts,
  };
  const authSignature = authCrypto.signSync(canonicalize(authPayload), identity.privateKeyHex);
  const ownerAuthorization = {
    payload: authPayload,
    signature: authSignature,
    senderPubkey: identity.senderPubkey,
  };

  await db
    .update(inferenceSessions)
    .set({
      status: 'resolving',
      updatedAt: new Date(),
      ownerAuthorization,
      ...(confirmedMetadata !== undefined ? { confirmedMetadata } : {}),
    })
    .where(eq(inferenceSessions.id, sessionId));

  log.info({ sessionId, ownerDid, senderPubkey: identity.senderPubkey }, 'intent confirmed and authorization signed — advancing to resolving');
}
