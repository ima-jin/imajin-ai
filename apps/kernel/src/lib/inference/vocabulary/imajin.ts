/**
 * Imajin reference vocabulary (#1216) — the 5 kernel primitives.
 *
 * This is the REFERENCE implementation every tenant can read to understand
 * the IntentVocabulary contract. It is NOT used by AgriFortress or any other
 * tenant; each tenant provides their own vocabulary instance.
 *
 * Intent types: note.self, message.connection, receipt.file, asset.share,
 *               discovery.context
 *
 * All read-your-own intents are 'silent'; boundary-crossing intents
 * (message.connection, asset.share) are 'deliberate'.
 *
 * resolve() MUST NOT import Imajin kernel internals beyond what is needed
 * for the 5 primitive actions. Kept minimal here — real primitive wiring
 * is the responsibility of each child issue that owns the primitive.
 */

import { createHash } from 'node:crypto';
import type { IntentVocabulary, CandidateIntent, ConsentTier, ResolutionReceipt } from './contract';

const SILENT_TYPES = new Set(['note.self', 'receipt.file', 'discovery.context']);

export const imajinVocabulary: IntentVocabulary = {
  name: 'imajin',
  modelProvider: 'anthropic',
  modelId: 'claude-sonnet-4-20250514',

  systemPrompt: `
You are the Imajin intention inference engine. Given a transcript + ambient context,
infer the most likely human intent from the following vocabulary:

- note.self        → a private note or reminder to oneself (read-your-own)
- message.connection → a message intended for one of the human's connections (boundary-crossing)
- receipt.file     → filing or logging a receipt, invoice, or document (read-your-own)
- asset.share      → sharing a media asset with a connection or publicly (boundary-crossing)
- discovery.context → a query or search to retrieve context or knowledge (read-your-own)

Produce a ranked JSON array of candidate intents.
`.trim(),

  resolveConsentTier(intentType: string): ConsentTier {
    return SILENT_TYPES.has(intentType) ? 'silent' : 'deliberate';
  },

  async resolve(intent: CandidateIntent, ownerDid: string): Promise<ResolutionReceipt> {
    // Reference implementation — stubs the 5 primitives.
    // Production child issues wire each primitive to its real handler.
    const payload = { intentType: intent.intentType, ownerDid, metadata: intent.metadata };
    const digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const resolvedAt = new Date().toISOString();

    return {
      primitiveType: intent.intentType,
      digest,
      resolvedAt,
    };
  },
};
