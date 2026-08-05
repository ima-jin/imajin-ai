/**
 * Inference policy layer (#1213) — where the brain gets plugged in.
 *
 * Signature: infer(ctx, vocab, credentialContext) → CandidateIntent[]
 *
 * The vocabulary supplies the intent schema (systemPrompt + consent tiers); the
 * MODEL comes from a sealed connector card via `resolveBrain` (#1621). Two axes
 * decide which card:
 *   - WHOSE credential (#1624): the acting owner DID first, then the invoking
 *     app/org DID, so an app can subsidise compute without moving attribution.
 *   - WHICH provider (#1621): each DID's sealed connectors, in resolver order.
 *
 * The kernel holds no model credential of its own and there is no env fallback,
 * so the credential context is required rather than optional — a call with no
 * DID has no brain to run on, and making it optional is exactly how the capture
 * route silently lost per-DID resolution.
 */

import { eq } from 'drizzle-orm';
import { db, inferenceSessions } from '@/src/db';
import { getModel, generateText } from '@imajin/llm';
import { createLogger } from '@imajin/logger';
import { resolveBrain, type BrainCredentialContext } from './brain';
import type { CandidateIntent, InferenceContext, IntentVocabulary } from './types';

const log = createLogger('kernel:inference:policy');

/**
 * Owner/app DID context for credential resolution (#1624).
 *
 * Declared by the brain resolver, which owns the walk order; re-exported here
 * because callers reach it through `infer`.
 */
export type ModelCredentialContext = BrainCredentialContext;

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
 * @param credentialContext - Whose sealed card may supply the model: the acting
 *   owner DID, optionally with an invoking app/org DID that may subsidise it
 *   (#1624). A bare string is treated as the owner DID. Required: there is no
 *   kernel-owned or env-var brain, so a call with no DID cannot resolve a
 *   credential. Throws `NoBrainSealedError` when none of the DIDs has sealed one.
 *   Consent and attribution stay attached to the owner DID regardless of which
 *   DID paid.
 */
export async function infer(
  ctx: InferenceContext,
  vocab: IntentVocabulary,
  credentialContext: string | ModelCredentialContext,
): Promise<CandidateIntent[]> {
  let rawText: string;
  try {
    // Brain resolution is inside the try so a missing connection marks the
    // session failed like any other policy failure — otherwise the session
    // would sit in `inferring` forever with no candidates and no explanation.
    const brain = await resolveBrain(credentialContext);
    const model = getModel(brain.provider, brain.modelId, {
      apiKey: brain.apiKey,
      ...(brain.baseURL === undefined ? {} : { baseURL: brain.baseURL }),
    });

    const systemPrompt = `${vocab.systemPrompt}\n\n${SYSTEM_SUFFIX}`;
    const userMessage = buildUserMessage(ctx);

    log.info(
      {
        sessionId: ctx.sessionId,
        vocab: vocab.name,
        connector: brain.connector,
        // Which DID's card paid — the owner's own, or the app subsidising it.
        credentialDid: brain.credentialDid,
        model: brain.modelId,
      },
      'running inference policy',
    );

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
