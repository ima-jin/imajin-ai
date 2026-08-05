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
import { loadGeminiCredentials } from '@/src/lib/gemini/connector';
import type { CandidateIntent, InferenceContext, IntentVocabulary } from './types';

const log = createLogger('kernel:inference:policy');

export interface ModelCredentialContext {
  /** Acting supplier/user DID. Consent and attribution stay attached here. */
  ownerDid?: string;
  /** Invoking app/org DID that may provide model credentials. */
  appDid?: string;
}

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
 *
 * @param credentialContext - Optional owner/app DID context for credential resolution.
 *   When provided and `vocab.modelChannel === 'gemini'`, credentials are
 *   resolved from the acting owner DID first, then the invoking app/org DID,
 *   falling back to GEMINI_API_KEY / GEMINI_BASE_URL env vars. Consent and
 *   attribution remain attached to the owner DID.
 */
export async function infer(
  ctx: InferenceContext,
  vocab: IntentVocabulary,
  credentialContext?: string | ModelCredentialContext,
): Promise<CandidateIntent[]> {
  const modelConfig = await resolveModelConfig(vocab, normalizeCredentialContext(credentialContext));
  const model = getModel(vocab.modelProvider, vocab.modelId, modelConfig);

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

/**
 * Resolve optional model config (apiKey, baseURL) for the vocab's provider.
 *
 * For `modelChannel === 'gemini'`: try the acting owner DID's sealed
 * connection first, then the invoking app/org DID's sealed connection, then
 * fall back to GEMINI_API_KEY / GEMINI_BASE_URL env vars. This replaces the old
 * "set OPENAI_API_KEY=$GEMINI_API_KEY in kernel env" workaround and supports
 * app-subsidized inference without changing attribution.
 * Returns `undefined` for all other channels (lets the SDK use its own env
 * var defaults).
 */
async function resolveModelConfig(
  vocab: IntentVocabulary,
  credentialContext: ModelCredentialContext,
): Promise<{ apiKey?: string; baseURL?: string } | undefined> {
  if (vocab.modelChannel !== 'gemini') {
    return undefined;
  }
  for (const did of credentialOwnerDids(credentialContext)) {
    const creds = await loadGeminiCredentials(did);
    if (creds) {
      return {
        apiKey: creds.apiKey,
        ...(creds.baseUrl ? { baseURL: creds.baseUrl } : {}),
      };
    }
  }

  // Env-var fallback — keeps local dev working without a sealed connection.
  const apiKey = process.env.GEMINI_API_KEY;
  const baseURL = process.env.GEMINI_BASE_URL;
  if (apiKey || baseURL) {
    return {
      ...(apiKey ? { apiKey } : {}),
      ...(baseURL ? { baseURL } : {}),
    };
  }

  return undefined;
}

function normalizeCredentialContext(
  credentialContext?: string | ModelCredentialContext,
): ModelCredentialContext {
  if (typeof credentialContext === 'string') {
    return { ownerDid: credentialContext };
  }
  return credentialContext ?? {};
}

function credentialOwnerDids(credentialContext: ModelCredentialContext): string[] {
  const seen = new Set<string>();
  const dids: string[] = [];
  for (const did of [credentialContext.ownerDid, credentialContext.appDid]) {
    if (!did || seen.has(did)) continue;
    seen.add(did);
    dids.push(did);
  }
  return dids;
}

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
      intentType: typeof item['intentType'] === 'string' ? item['intentType'] : '',
        confidence: Number(item['confidence'] ?? 0),
        metadata: (typeof item['metadata'] === 'object' && item['metadata'] !== null)
          ? (item['metadata'] as Record<string, unknown>)
          : {},
        consentTier: vocab.resolveConsentTier(typeof item['intentType'] === 'string' ? item['intentType'] : ''),
      }))
      .filter((c) => c.intentType !== '')
      .sort((a, b) => b.confidence - a.confidence);
  } catch (err) {
    log.warn({ err: String(err), rawText, sessionId }, 'Failed to parse inference response');
    return [];
  }
}
