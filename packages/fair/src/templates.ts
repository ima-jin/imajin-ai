import type { FairManifestV1_1, FairDistributionRight, Money } from './types';

export type FairTemplate = "media" | "ticket" | "course" | "module" | "document" | "custom";

export interface TemplateConfig {
  name: string;
  description: string;
  sections: {
    attribution: boolean;
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
      { did: ownerDid, role: 'creator', share: 0.99 },
      { role: 'platform', name: 'Imajin', share: 0.01 },
    ],
    distribution,
    transfer: { allowed: true, requiresAttribution: true, price: transferPrice, resaleRoyaltyBps: 500 },
    fees: [
      { role: 'protocol', name: 'MJN', rateBps: 100, fixedCents: 0 },
      { role: 'node', name: 'Node', rateBps: 50, fixedCents: 0 },
      { role: 'buyer_credit', name: 'Buyer Credit', rateBps: 25, fixedCents: 0 },
      { role: 'scope', name: 'Scope', rateBps: 25, fixedCents: 0 },
    ],
    training: { allowed: false },
    commercial: { allowed: false, contactRequired: true },
    tipping: { enabled: true },
  };

  return manifest;
}
