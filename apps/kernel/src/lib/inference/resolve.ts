/**
 * Primitive resolution + proof-of-history signing (#1215).
 *
 * Called after the consent gate returns 'proceed' (silent) or after the
 * human has confirmed (deliberate). Steps:
 *
 *   1. Load the session (validates status = 'resolving').
 *   2. Reconstruct the chosen CandidateIntent from the session's stored data.
 *   3. Call vocab.resolve(intent, ownerDid) — the tenant executes its domain action.
 *   4. Fetch the source asset's CID for provenance chaining.
 *   5. Sign the attestation payload with node identity and write the row.
 *   6. Publish inference.resolved DFOS event (federated, best-effort).
 *   7. Advance session to 'resolved'.
 */

import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import { eq } from 'drizzle-orm';
import { db, assets, inferenceSessions, inferenceAttestations } from '@/src/db';
import { publishContentEvent } from '@imajin/dfos';
import { createLogger } from '@imajin/logger';
import { canonicalize, crypto as authCrypto } from '@imajin/auth';
import { getNodeSigningIdentity } from '@/src/lib/vault/sealing';
import type { CandidateIntent, IntentVocabulary } from './types';

const log = createLogger('kernel:inference:resolve');

export interface ResolveResult {
  attestationId: string;
  intentType: string;
  primitiveType: string;
  externalId?: string;
  resolvedAt: string;
}

/**
 * Execute the confirmed intent and write a signed attestation.
 *
 * Must only be called when session.status === 'resolving'. The consent module
 * is responsible for reaching that state.
 */
export async function resolveIntent(
  sessionId: string,
  ownerDid: string,
  vocab: IntentVocabulary,
): Promise<ResolveResult> {
  // 1. Load and validate the session.
  const [session] = await db
    .select()
    .from(inferenceSessions)
    .where(eq(inferenceSessions.id, sessionId))
    .limit(1);

  if (!session) throw new Error(`Session ${sessionId} not found`);
  if (session.ownerDid !== ownerDid) throw new Error('Session owner mismatch');
  if (session.status !== 'resolving') {
    throw new Error(`Session is not in resolving state (status: ${session.status})`);
  }

  // 2. Reconstruct the chosen intent from persisted session data.
  const candidates = (session.candidateIntents ?? []) as CandidateIntent[];
  const intentType = session.chosenIntentType;
  const intent = candidates.find((c) => c.intentType === intentType) ?? buildStubIntent(session);

  // 3. Execute the domain action via the mounted vocabulary.
  log.info({ sessionId, intentType: intent.intentType, vocab: vocab.name }, 'resolving intent');
  let receipt;
  try {
    receipt = await vocab.resolve(intent, ownerDid);
  } catch (err) {
    await db
      .update(inferenceSessions)
      .set({ status: 'failed', updatedAt: new Date() })
      .where(eq(inferenceSessions.id, sessionId));
    throw new Error(`Vocabulary resolution failed: ${String(err)}`);
  }

  // 4. Fetch the source asset's CID for provenance chaining.
  const [sourceAsset] = await db
    .select({ cid: assets.cid })
    .from(assets)
    .where(eq(assets.id, session.assetId))
    .limit(1);

  // 5. Sign the attestation payload and write the row.
  const attestationId = `attest_${nanoid(16)}`;
  const signingIdentity = getNodeSigningIdentity();
  const signedAt = new Date().toISOString();
  const attestationPayload = {
    id: attestationId,
    sessionId,
    ownerDid,
    vocabularyName: vocab.name,
    intentType: intent.intentType,
    consentTier: intent.consentTier,
    sourceCid: sourceAsset?.cid ?? null,
    signedAt,
  };
  const signature = authCrypto.signSync(canonicalize(attestationPayload), signingIdentity.privateKeyHex);

  const [attestation] = await db
    .insert(inferenceAttestations)
    .values({
      id: attestationId,
      sessionId,
      ownerDid,
      vocabularyName: vocab.name,
      intentType: intent.intentType,
      consentTier: intent.consentTier,
      confidence: intent.confidence,
      resolutionReceipt: receipt,
      sourceAssetId: session.assetId,
      sourceCid: sourceAsset?.cid ?? null,
      signature,
      senderPubkey: signingIdentity.senderPubkey,
    })
    .returning();

  log.info({ attestationId, senderPubkey: signingIdentity.senderPubkey }, 'inference attestation signed and written');

  // 6. Publish DFOS event (best-effort, non-fatal).
  publishContentEvent({
    topic: 'inference.resolved',
    payload: {
      attestationId,
      sessionId,
      ownerDid,
      vocabularyName: vocab.name,
      intentType: intent.intentType,
      consentTier: intent.consentTier,
      primitiveType: receipt.primitiveType,
      digest: receipt.digest,
      resolvedAt: receipt.resolvedAt,
    },
  })
    .then(async (dfosResult) => {
      if (dfosResult?.eventId) {
        await db
          .update(inferenceAttestations)
          .set({ dfosEventId: dfosResult.eventId })
          .where(eq(inferenceAttestations.id, attestationId));
      }
    })
    .catch((err: unknown) => {
      log.error({ err: String(err), attestationId }, 'DFOS inference.resolved publish failed (non-fatal)');
    });

  // 7. Advance session to 'resolved'.
  await db
    .update(inferenceSessions)
    .set({ status: 'resolved', updatedAt: new Date() })
    .where(eq(inferenceSessions.id, sessionId));

  log.info(
    { sessionId, attestationId, intentType: intent.intentType, primitiveType: receipt.primitiveType },
    'intent resolved and attested',
  );

  return {
    attestationId,
    intentType: intent.intentType,
    primitiveType: receipt.primitiveType,
    externalId: receipt.externalId,
    resolvedAt: receipt.resolvedAt,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal stub intent when the stored candidates list is missing the chosen type. */
function buildStubIntent(session: { chosenIntentType: string | null; consentTier: string | null }): CandidateIntent {
  const intentType = session.chosenIntentType ?? 'unknown';
  const consentTier = (session.consentTier as 'silent' | 'itemized' | 'deliberate') ?? 'deliberate';
  return {
    intentType,
    confidence: 1,
    metadata: {},
    consentTier,
  };
}

/** Helper: sha256 hex digest of an arbitrary JSON-serialisable value. */
export function digestOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
