import type { FairFeeManifest, FairManifestV11 } from '../../src/types';

/** Representative stored document: deliberately retain string-form access. */
export const storedDocumentManifest: FairManifestV11 = {
  fair: '1.1',
  version: '1.1',
  id: 'asset_stored_document',
  type: 'text/markdown',
  owner: 'did:imajin:stored-creator',
  created: '2026-01-02T03:04:05.000Z',
  access: 'private',
  attribution: [{ did: 'did:imajin:stored-creator', role: 'creator', share: 1 }],
  chain: [
    { did: 'did:imajin:platform', role: 'platform', share: 0.02 },
    { did: 'did:imajin:stored-creator', role: 'seller', share: 0.98 },
  ],
  distributions: [{ did: 'did:imajin:stored-creator', role: 'creator', share: 1 }],
  fees: [{ role: 'processor', name: 'Stripe', rateBps: 370, fixedCents: 30 }],
  distribution: { reproduction: { mode: 'quote-with-attribution', quote: { maxWords: 200 } } },
  transfer: { allowed: false },
  training: { allowed: false },
  terms: 'Preserve these stored terms.',
  provenance: [{ attestationId: 'att_stored_document', type: 'intro_made' }],
};

/** Representative stored event fee record, with no document fields to invent. */
export const storedFeeManifest: FairFeeManifest = {
  version: '0.4.0',
  fees: [{ role: 'processor', name: 'Stripe', rateBps: 370, fixedCents: 30 }],
  chain: [
    { did: 'did:imajin:protocol', role: 'protocol', share: 0.01 },
    { did: 'NODE_PLACEHOLDER', role: 'node', share: 0.005 },
    { did: 'BUYER_PLACEHOLDER', role: 'buyer_credit', share: 0.005 },
    { did: 'did:imajin:platform', role: 'platform', share: 0.02 },
    { did: 'did:imajin:stored-creator', role: 'seller', share: 0.96 },
  ],
  distributions: [
    { did: 'did:imajin:stored-creator', role: 'creator', share: 0.75 },
    { did: 'did:imajin:stored-collaborator', role: 'collaborator', share: 0.25 },
  ],
  attribution: [{ did: 'did:imajin:stored-creator', role: 'creator', share: 1 }],
};
