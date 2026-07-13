/**
 * Inference policy layer (#1213) — the pluggable brain.
 *
 * Signature: infer(ctx, vocab) → CandidateIntent[]
 *
 * Uses @imajin/llm (Vercel AI SDK) with the vocabulary's model adapter to
 * produce a ranked list of candidate intents from the transcript + priors.
 * The LLM is prompted with the vocab's systemPrompt so it knows the intent
 * vocabulary and expected JSON output schema.
 */

import { eq } from 'drizzle-orm';
import { db, inferenceSessions } from '@/src/db';
import { getModel, generateText } from '@imajin/llm';
import { createLogger } from '@imajin/logger';
import type { CandidateIntent, InferenceContext, IntentVocabulary } from './types';

const log = createLogger('kernel:inference:policy');

const SYSTEM_SUFFIX = `
Respond with a JSON array of candidate intents, ranked by confidence (highest first).
Each object must have exactly these fields:
  intentType: string   — one of the intent types listed above
  confidence: number   — 0.0 to 1.0
  metadata: object     — structured payload extracted from the transcript
Return ONLY the JSON array, no surrounding text.
`.trim();

/**
 * Run the inference policy: transcript + priors + vocab → ranked CandidateIntent[].
 *
 * Updates the session row with the resulting candidate intents and advances
 * status to ready for consent gate.
 */
export async function infer(
  ctx: InferenceContext,
  vocab: IntentVocabulary,
): Promise<CandidateIntent[]> {
  const model = getModel(vocab.modelProvider, vocab.modelId);

  const systemPrompt = `${vocab.systemPrompt}\n\n${SYSTEM_SUFFIX}`;
  const userMessage = buildUserMessage(ctx);

  log.info(
    { sessionId: ctx.sessionId, vocab: vocab.name, model: vocab.modelId },
    'running inference policy',
  );

  let rawText: string;
  try {
    const result = await generateText({ model, system: systemPrompt, prompt: userMessage });
    rawText = result.text;
  } catch (err) {
    log.error({ err: String(err), sessionId: ctx.sessionId }, 'LLM inference failed');
    await db
      .update(inferenceSessions)
      .set({ status: 'failed', updatedAt: new Date() })
      .where(eq(inferenceSessions.id, ctx.sessionId));
    throw new Error(`Inference policy failed: ${String(err)}`);
  }

  // Parse the JSON array from the model response.
  const candidates = parseCandidates(rawText, vocab, ctx.sessionId);

  // Persist candidate intents and advance session status.
  await db
    .update(inferenceSessions)
    .set({ candidateIntents: candidates, status: 'policy_done', updatedAt: new Date() })
    .where(eq(inferenceSessions.id, ctx.sessionId));

  log.info(
    { sessionId: ctx.sessionId, count: candidates.length, top: candidates[0]?.intentType },
    'inference policy complete',
  );

  return candidates;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildUserMessage(ctx: InferenceContext): string {
  const lines: string[] = [
    `Transcript: ${ctx.transcript || '(empty)'}`,
    `Time of day: ${ctx.priors.timeOfDay}`,
  ];
  if (ctx.priors.recentConnectionDids.length > 0) {
    lines.push(`Recent connections: ${ctx.priors.recentConnectionDids.join(', ')}`);
  }
  if (ctx.priors.recentActivitySummary) {
    lines.push(`Recent activity: ${ctx.priors.recentActivitySummary}`);
  }
  return lines.join('\n');
}

function parseCandidates(
  rawText: string,
  vocab: IntentVocabulary,
  sessionId: string,
): CandidateIntent[] {
  try {
    // Strip any markdown code fences the model may have added.
    const cleaned = rawText.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
    const parsed = JSON.parse(cleaned) as unknown;
    if (!Array.isArray(parsed)) throw new Error('Expected array');

    return parsed
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map((item) => ({
        intentType: String(item['intentType'] ?? ''),
        confidence: Number(item['confidence'] ?? 0),
        metadata: (typeof item['metadata'] === 'object' && item['metadata'] !== null)
          ? (item['metadata'] as Record<string, unknown>)
          : {},
        consentTier: vocab.resolveConsentTier(String(item['intentType'] ?? '')),
      }))
      .filter((c) => c.intentType !== '')
      .sort((a, b) => b.confidence - a.confidence);
  } catch (err) {
    log.warn({ err: String(err), rawText, sessionId }, 'Failed to parse inference response');
    return [];
  }
}
