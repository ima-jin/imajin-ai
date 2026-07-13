/**
 * AgriFortress vocabulary (#1216) — first real tenant mount.
 *
 * Forcing function: AgriFortress (catalyst-power/xprize#5) ships on the
 * Aug 17 XPRIZE clock. This is the first concrete vocabulary that proves
 * the engine's breadth (AgriFortress supply + Artifact operator = two tenants,
 * same shell, no fork).
 *
 * Intent types:
 *   supply.received   → farmer records receiving a supply delivery (voice primary)
 *   lot.opened        → farmer opens a new supply lot / batch
 *   delivery.noted    → farmer notes a delivery for later reconciliation
 *
 * ALL intents are 'deliberate' — the one-confirm tap IS the consent gate.
 * AgriFortress: voice = count + intent; photo = evidence, NOT measurement.
 *
 * Model: Gemini via OpenAI-compat (GEMINI_BASE_URL env var).
 *
 * Hard boundary: resolve() MUST NOT import Imajin kernel internals. It calls
 * the catalyst-power supply domain API exclusively.
 */

import { createHash } from 'node:crypto';
import type { IntentVocabulary, CandidateIntent, ConsentTier, ResolutionReceipt } from './contract';

const SUPPLY_API_URL = process.env.AGRIFORTRESS_SUPPLY_API_URL ?? '';
const SUPPLY_API_KEY = process.env.AGRIFORTRESS_SUPPLY_API_KEY ?? '';

export const agrifortressVocabulary: IntentVocabulary = {
  name: 'agrifortress',
  // Gemini via OpenAI-compat. GEMINI_BASE_URL must point to the Gemini
  // OpenAI-compatible endpoint (e.g. https://generativelanguage.googleapis.com/v1beta/openai).
  // GEMINI_API_KEY is picked up by the OpenAI SDK from OPENAI_API_KEY env var;
  // set OPENAI_API_KEY=$GEMINI_API_KEY in the kernel env when using this vocab.
  modelProvider: 'openai',
  modelId: process.env.GEMINI_MODEL_ID ?? 'gemini-2.0-flash',

  systemPrompt: `
You are the AgriFortress supply-chain inference engine. A farmer speaks a voice note
describing supply activity. Extract the intent from the following vocabulary:

- supply.received   → farmer received a delivery of inputs (seeds, fertiliser, chemicals, tools)
- lot.opened        → farmer is opening a new batch or lot for tracking
- delivery.noted    → farmer is noting a delivery for later reconciliation (no immediate action)

For each candidate, extract a metadata object with these fields (omit unknown fields):
  product:   string   (what was received, e.g. "maize seed", "fertiliser")
  qty:       number   (quantity, if mentioned)
  unit:      string   (unit of quantity, e.g. "kg", "bags", "litres")
  recipient: string   (who it's for, if mentioned — often the farmer themselves)
  lot:       string   (lot or batch identifier, if mentioned)
  notes:     string   (any other relevant detail)

Produce a ranked JSON array of candidate intents.
`.trim(),

  resolveConsentTier(_intentType: string): ConsentTier {
    // ALL AgriFortress intents require deliberate confirmation — one-confirm tap.
    return 'deliberate';
  },

  async resolve(intent: CandidateIntent, ownerDid: string): Promise<ResolutionReceipt> {
    const resolvedAt = new Date().toISOString();
    const payload = {
      intentType: intent.intentType,
      ownerDid,
      metadata: intent.metadata,
      resolvedAt,
    };
    const digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex');

    if (!SUPPLY_API_URL) {
      // No supply API configured — return a stub receipt for development.
      return {
        primitiveType: intent.intentType,
        digest,
        resolvedAt,
      };
    }

    // POST to the catalyst-power supply domain API.
    // Tenant-owned: no Imajin kernel internals used here.
    const res = await fetch(`${SUPPLY_API_URL}/supply/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(SUPPLY_API_KEY ? { Authorization: `Bearer ${SUPPLY_API_KEY}` } : {}),
      },
      body: JSON.stringify({
        type: intent.intentType,
        ownerDid,
        metadata: intent.metadata,
        attestedAt: resolvedAt,
      }),
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => '');
      throw new Error(`AgriFortress supply API error ${res.status}: ${errorText}`);
    }

    const result = await res.json() as { id?: string };

    return {
      primitiveType: intent.intentType,
      externalId: result.id,
      digest,
      resolvedAt,
    };
  },
};
