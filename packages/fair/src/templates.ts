import type { FairManifestV1_1, Money } from './types';
import {
  PROTOCOL_FEE_BPS,
  PROTOCOL_DID,
  NODE_FEE_DEFAULT_BPS,
  BUYER_CREDIT_DEFAULT_BPS,
  PLATFORM_FEE_BPS,
  PLATFORM_DID,
  STRIPE_RATE_BPS,
  STRIPE_MIN_RATE_BPS,
  STRIPE_FIXED_CENTS,
} from './constants';

export type FairTemplate = "media" | "ticket" | "course" | "module" | "document" | "custom";

export interface TemplateConfig {
  name: string;
  description: string;
  sections: {
    attribution: boolean;
    chain: boolean;
    fees: boolean;
    access: boolean;
    transfer: boolean;
    integrity: boolean;
    intent: boolean;
    terms: boolean;
    distributions: boolean;
  };
  defaults?: Partial<FairManifestV1_1>;
}

export const templates: Record<FairTemplate, TemplateConfig> = {
  media: {
    name: "Media",
    description: "Audio, video, or image content with transfer and integrity tracking.",
    sections: {
      attribution: true,
      chain: true,
      fees: true,
      access: true,
      transfer: true,
      integrity: true,
      intent: false,
      terms: true,
      distributions: false,
    },
    defaults: {
      transfer: { allowed: true, requiresAttribution: true, price: { amount: 100000, currency: 'USD' }, resaleRoyaltyBps: 500 },
    },
  },
  ticket: {
    name: "Ticket",
    description: "Event or access ticket with transfer controls and stated purpose.",
    sections: {
      attribution: true,
      chain: true,
      fees: true,
      access: true,
      transfer: true,
      integrity: false,
      intent: true,
      terms: true,
      distributions: false,
    },
    defaults: {
      transfer: { allowed: true, faceValueCap: true, resaleRoyaltyBps: 500 },
    },
  },
  course: {
    name: "Course",
    description: "Educational course with distribution splits and stated learning intent.",
    sections: {
      attribution: true,
      chain: true,
      fees: true,
      access: true,
      transfer: false,
      integrity: false,
      intent: true,
      terms: true,
      distributions: true,
    },
    defaults: {
      access: { type: "private" },
    },
  },
  module: {
    name: "Module",
    description: "Standalone content module or lesson, minimal configuration.",
    sections: {
      attribution: true,
      chain: true,
      fees: true,
      access: true,
      transfer: false,
      integrity: false,
      intent: false,
      terms: true,
      distributions: false,
    },
  },
  document: {
    name: "Document",
    description: "Written document or file with integrity verification.",
    sections: {
      attribution: true,
      chain: true,
      fees: true,
      access: true,
      transfer: false,
      integrity: true,
      intent: false,
      terms: true,
      distributions: false,
    },
  },
  custom: {
    name: "Custom",
    description: "Fully custom manifest — all sections visible.",
    sections: {
      attribution: true,
      chain: true,
      fees: true,
      access: true,
      transfer: true,
      integrity: true,
      intent: true,
      terms: true,
      distributions: true,
    },
  },
};

// ─── Default manifest builder (v1.1) ───────────────────────────────────────

function mimeBucket(mimeType: string): 'text' | 'image' | 'audio' | 'video' | 'other' {
  if (mimeType.startsWith('text/')) return 'text';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  return 'other';
}

/**
 * Build a default v1.1 .fair manifest for a newly-uploaded asset.
 * This is the single source of truth for upload defaults.
 *
 * @param mimeType — e.g. "image/png", "audio/mpeg", "text/markdown"
 * @param ownerDid — the uploader's DID
 * @returns a complete FairManifestV1_1
 */
export function getDefaultManifest(mimeType: string, ownerDid: string): FairManifestV1_1 {
  const bucket = mimeBucket(mimeType);
  const now = new Date().toISOString();

  const transferPrice: Money = { amount: 100000, currency: 'USD' };

  const distribution: NonNullable<FairManifestV1_1['distribution']> = {
    reproduction: { mode: 'allowed' },
    streaming: { mode: 'allowed', price: { amount: 1, currency: 'USD' } },
    derivative: { mode: 'allow-with-attribution' },
    syndication: { mode: 'allow-with-attribution' },
  };

  if (bucket === 'text') {
    distribution.reproduction = {
      mode: 'quote-with-attribution',
      quote: { maxPercent: 25, maxWords: 200 },
    };
  }

  if (bucket === 'image') {
    distribution.derivative = { mode: 'allow-with-attribution' };
  }

  if (bucket === 'audio') {
    distribution.derivative = {
      mode: 'allow-with-share',
      sampling: { allowed: 'allow-with-share', share: 0.05 },
      sync: { allowed: 'reserved' },
    };
  }

  if (bucket === 'video') {
    distribution.derivative = {
      mode: 'allow-with-attribution',
      sync: { allowed: 'reserved' },
    };
  }

  const protocolShare = PROTOCOL_FEE_BPS / 10000;
  const nodeShare = NODE_FEE_DEFAULT_BPS / 10000;
  const buyerCreditShare = BUYER_CREDIT_DEFAULT_BPS / 10000;
  const platformShare = PLATFORM_FEE_BPS / 10000;
  const sellerShare = 1 - protocolShare - nodeShare - buyerCreditShare - platformShare;

  const manifest: FairManifestV1_1 = {
    fair: '1.1',
    version: '1.1',
    id: '', // caller fills this after asset ID is generated
    type: mimeType,
    owner: ownerDid,
    created: now,
    source: 'upload',
    access: { type: 'private' },
    attribution: [
      { did: ownerDid, role: 'creator', share: 1.0 },
    ],
    chain: [
      { did: PROTOCOL_DID, role: 'protocol', share: protocolShare },
      { did: 'NODE_PLACEHOLDER', role: 'node', share: nodeShare },
      { did: 'BUYER_PLACEHOLDER', role: 'buyer_credit', share: buyerCreditShare },
      { did: PLATFORM_DID, role: 'platform', share: platformShare },
      { did: ownerDid, role: 'seller', share: sellerShare },
    ],
    distribution,
    transfer: { allowed: true, requiresAttribution: true, price: transferPrice, resaleRoyaltyBps: 500 },
    fees: [
      { role: 'processor', name: 'Stripe', rateBps: STRIPE_RATE_BPS, minRateBps: STRIPE_MIN_RATE_BPS, fixedCents: STRIPE_FIXED_CENTS },
    ],
    training: { allowed: false },
    commercial: { allowed: false, contactRequired: true },
    tipping: { enabled: true },
  };

  return manifest;
}
