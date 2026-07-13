/**
 * MCP tools for the Intention Inference Engine (#1198).
 *
 * inference_capture ΓÇö trigger the inference pipeline from an asset or text.
 * inference_status  ΓÇö read session status + attestation for the agent.
 *
 * Both tools require the 'inference:write' scope gate (agents that can write
 * media can also trigger inference ΓÇö add a separate scope if needed later).
 */

import type { McpTool } from '../types';
import { str, json } from './utils';
import { db, inferenceSessions, inferenceAttestations } from '@/src/db';
import { eq, and } from 'drizzle-orm';
import { gatherContext } from '@/src/lib/inference/context';
import { infer } from '@/src/lib/inference/policy';
import { resolveConsentGate } from '@/src/lib/inference/consent';
import { resolveIntent } from '@/src/lib/inference/resolve';
import { getVocabulary, listVocabularyNames } from '@/src/lib/inference/vocabulary';
import { nanoid } from 'nanoid';
import { createAsset } from '@/src/lib/media/create-asset';


// ---------------------------------------------------------------------------
// inference_capture
// ---------------------------------------------------------------------------

const inferenceCaptureTool: McpTool = {
  name: 'inference_capture',
  requiredScope: 'media:write',
  description:
    'Trigger the intention inference pipeline from text input or an existing asset ID. ' +
    'Returns the session ID, inferred candidate intents, and status. ' +
    'For deliberate intents, the human must confirm via POST /api/inference/confirm/:sessionId. ' +
    'vocabulary: imajin (default) or agrifortress.',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Text transcript to infer intent from.' },
      assetId: { type: 'string', description: 'Existing media asset ID to infer intent from (uses stored asset + transcript).' },
      vocabulary: {
        type: 'string',
        enum: ['imajin', 'agrifortress'],
        description: 'Vocabulary to mount. Defaults to imajin.',
      },
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const text = str(args, 'text');
    const assetId = str(args, 'assetId');
    const vocabName = str(args, 'vocabulary') ?? 'imajin';
    const vocab = getVocabulary(vocabName);

    if (!vocab) {
      throw new Error(`Unknown vocabulary '${vocabName}'. Available: ${listVocabularyNames().join(', ')}`);
    }
    if (!text && !assetId) {
      throw new Error('Provide either text or assetId');
    }

    // If text only: create a minimal text asset and a session row.
    let resolvedAssetId = assetId;
    let sessionId: string;

    if (!resolvedAssetId && text) {
      const { asset } = await createAsset({
        ownerDid: ctx.did,
        buffer: Buffer.from(text, 'utf8'),
        filename: `inference-${nanoid(8)}.txt`,
        mimeType: 'text/plain',
        context: { feature: 'voice' },
        access: 'private',
        dedup: false,
        classify: false,
      });
      resolvedAssetId = asset.id;
    }

    if (!resolvedAssetId) throw new Error('Could not resolve asset');

    // Open a session row if we don't have one from captureGesture.
    sessionId = `session_${nanoid(16)}`;
    await db.insert(inferenceSessions).values({
      id: sessionId,
      ownerDid: ctx.did,
      vocabularyName: vocabName,
      assetId: resolvedAssetId,
      // If text was provided, pre-fill transcript directly.
      transcript: text ?? null,
      status: text ? 'inferring' : 'capturing',
    });

    // Gather context (transcribes if audio asset; uses stored text otherwise).
    const inferCtx = await gatherContext(sessionId, resolvedAssetId, ctx.did);
    if (text) {
      // gatherContext may overwrite transcript; re-apply the provided text.
      inferCtx.transcript = text;
    }

    const candidates = await infer(inferCtx, vocab);
    const topIntent = candidates[0];
    if (!topIntent) {
      return json({ sessionId, assetId: resolvedAssetId, status: 'failed', error: 'No candidates inferred' });
    }

    const gate = await resolveConsentGate(sessionId, topIntent);

    if (gate === 'proceed') {
      const result = await resolveIntent(sessionId, ctx.did, vocab);
      return json({
        sessionId,
        assetId: resolvedAssetId,
        status: 'resolved',
        attestationId: result.attestationId,
        intentType: result.intentType,
        primitiveType: result.primitiveType,
        resolvedAt: result.resolvedAt,
      });
    }

    return json({
      sessionId,
      assetId: resolvedAssetId,
      status: 'pending_confirm',
      candidateIntents: candidates,
      message: `Deliberate intent '${topIntent.intentType}' requires human confirmation. POST /api/inference/confirm/${sessionId}`,
    });
  },
};

// ---------------------------------------------------------------------------
// inference_status
// ---------------------------------------------------------------------------

const inferenceStatusTool: McpTool = {
  name: 'inference_status',
  requiredScope: 'media:read',
  description: 'Read the status and attestation of an inference session by ID.',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', description: 'The session ID returned from inference_capture.' },
    },
    required: ['sessionId'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const sessionId = str(args, 'sessionId');
    if (!sessionId) throw new Error('sessionId is required');

    const [session] = await db
      .select()
      .from(inferenceSessions)
      .where(and(eq(inferenceSessions.id, sessionId), eq(inferenceSessions.ownerDid, ctx.did)))
      .limit(1);

    if (!session) throw new Error('Session not found');

    let attestation = null;
    if (session.status === 'resolved') {
      const [att] = await db
        .select()
        .from(inferenceAttestations)
        .where(eq(inferenceAttestations.sessionId, sessionId))
        .limit(1);
      attestation = att ?? null;
    }

    return json({
      sessionId: session.id,
      vocabularyName: session.vocabularyName,
      assetId: session.assetId,
      status: session.status,
      chosenIntentType: session.chosenIntentType,
      consentTier: session.consentTier,
      candidateIntents: session.candidateIntents,
      attestation,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    });
  },
};

export const inferenceTools: McpTool[] = [inferenceCaptureTool, inferenceStatusTool];
