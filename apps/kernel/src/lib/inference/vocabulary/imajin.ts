/**
 * Imajin reference vocabulary (#1216) — the 6 kernel primitives.
 *
 * This is the REFERENCE implementation every tenant can read to understand
 * the IntentVocabulary contract. It is NOT used by AgriFortress or any other
 * tenant; each tenant provides their own vocabulary instance.
 *
 * Intent types: note.self, message.connection, receipt.file, asset.share,
 *               discovery.context, revoke.withdraw, revoke.tombstone,
 *               revoke.destroy, revoke.propagate
 *
 * All read-your-own intents are 'silent'; boundary-crossing intents
 * (message.connection, asset.share, revoke.tombstone, revoke.destroy,
 * revoke.propagate) are 'deliberate'.
 *
 * The revoke.* family (#2027) is Revocation, the sixth primitive: the option
 * to leave. Unlike the other five, its force is directed at *other* sentences
 * already in the record (it acts on validity, not on the world), tiered as
 * withdraw → soft (tombstone) → hard (destroy). revoke.propagate is modeled
 * as its own intent because propagation is part of the primitive —
 * revocation without propagation is theater. Named ahead of the lived
 * experience: like the other stubs below, resolve() does not yet wire a
 * real tombstone store, key-destruction path, or propagation transport —
 * that build waits for the use case that forces it (#2027).
 *
 * resolve() MUST NOT import Imajin kernel internals beyond what is needed
 * for the 6 primitive actions. Kept minimal here — real primitive wiring
 * is the responsibility of each child issue that owns the primitive.
 */

import { createHash } from 'node:crypto';
import type { IntentVocabulary, CandidateIntent, ConsentTier, ResolutionReceipt } from './contract';

const SILENT_TYPES = new Set(['note.self', 'receipt.file', 'discovery.context', 'revoke.withdraw']);

export const imajinVocabulary: IntentVocabulary = {
  name: 'imajin',

  systemPrompt: `
You are the Imajin intention inference engine. Given a transcript + ambient context,
infer the most likely human intent from the following vocabulary:

- note.self        → a private note or reminder to oneself (read-your-own)
- message.connection → a message intended for one of the human's connections (boundary-crossing)
- receipt.file     → filing or logging a receipt, invoice, or document (read-your-own)
- asset.share      → sharing a media asset with a connection or publicly (boundary-crossing)
- discovery.context → a query or search to retrieve context or knowledge (read-your-own)
- revoke.withdraw   → stop future participation in something; the past record stands (read-your-own)
- revoke.tombstone  → mark a prior attestation invalid; its shape stays visible, its content no longer stands (boundary-crossing)
- revoke.destroy    → hard-destroy the underlying hash/key behind a tombstoned record; the tombstone remains, what it protected doesn't (boundary-crossing)
- revoke.propagate  → push a revocation (tombstone or destroy) to every node holding a copy — revocation without propagation is theater (boundary-crossing)

Produce a ranked JSON array of candidate intents.
`.trim(),

  resolveConsentTier(intentType: string): ConsentTier {
    return SILENT_TYPES.has(intentType) ? 'silent' : 'deliberate';
  },

  resolve(intent: CandidateIntent, ownerDid: string): Promise<ResolutionReceipt> {
    // Reference implementation — stubs the 6 primitives, including the
    // revoke.* family (#2027). Production child issues wire each primitive,
    // including tombstone storage, hard-destroy key handling, and
    // propagation transport, to its real handler.
    // The Promise executor turns a synchronous throw into a rejection, so the
    // `VocabularyAdapter.resolve` Promise contract (callers' `.catch`) holds.
    return new Promise((resolve) => {
      const payload = { intentType: intent.intentType, ownerDid, metadata: intent.metadata };
      const digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
      const resolvedAt = new Date().toISOString();

      resolve({
        primitiveType: intent.intentType,
        digest,
        resolvedAt,
      });
    });
  },
};
