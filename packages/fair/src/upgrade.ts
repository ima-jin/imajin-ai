import type { FairManifestV1_0, FairManifestV1_1, FairDistributionRight, Money } from './types';

import { PLATFORM_DID, PROTOCOL_DID } from './constants';

function asDistributionRight(mode: string): FairDistributionRight {
  return { mode };
}

function mimeBucket(mimeType: string | undefined | null): 'text' | 'image' | 'audio' | 'video' | 'other' {
  if (!mimeType || typeof mimeType !== 'string') return 'other';
  if (mimeType.startsWith('text/')) return 'text';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  return 'other';
}

function buildDefaults(mimeType: string, ownerDid: string): {
  distribution: NonNullable<FairManifestV1_1['distribution']>;
  transfer: NonNullable<FairManifestV1_1['transfer']>;
  training: NonNullable<FairManifestV1_1['training']>;
  commercial: NonNullable<FairManifestV1_1['commercial']>;
  fees: NonNullable<FairManifestV1_1['fees']>;
  tipping: NonNullable<FairManifestV1_1['tipping']>;
  chain: NonNullable<FairManifestV1_1['chain']>;
} {
  const bucket = mimeBucket(mimeType);

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

  const fees: NonNullable<FairManifestV1_1['fees']> = [
    { role: 'protocol', name: 'MJN', rateBps: 100, fixedCents: 0 },
    { role: 'node', name: 'Node', rateBps: 50, fixedCents: 0 },
    { role: 'buyer_credit', name: 'Buyer Credit', rateBps: 25, fixedCents: 0 },
    { role: 'scope', name: 'Scope', rateBps: 25, fixedCents: 0 },
  ];

  const chain: NonNullable<FairManifestV1_1['chain']> = [
    { did: PROTOCOL_DID, role: 'protocol', share: 0.01 },
    { did: 'NODE_PLACEHOLDER', role: 'node', share: 0.005 },
    { did: 'BUYER_PLACEHOLDER', role: 'buyer_credit', share: 0.0025 },
    { did: PLATFORM_DID, role: 'platform', share: 0.01 },
    { did: ownerDid, role: 'seller', share: 0.9725 },
  ];

  return {
    distribution,
    transfer: { allowed: true, requiresAttribution: true, price: transferPrice, resaleRoyaltyBps: 500 },
    training: { allowed: false },
    commercial: { allowed: false, contactRequired: true },
    fees,
    tipping: { enabled: true },
    chain,
  };
}

const EPSILON = 0.001;

/**
 * Convert a DidShareList from v1.0 attribution/chain format.
 *
 * Migration must produce a manifest that passes the totals=100% validator,
 * otherwise the upgraded asset becomes uneditable garbage. We handle three
 * cases:
 *
 *   1. Single creator entry — apply the new 99/1 default (owner + Imajin
 *      platform). This covers both the canonical share=1.0 case and the
 *      "share was bogus from v1.0" case (e.g. share=0.52 with no other
 *      entries, which we saw in the wild on dev assets).
 *
 *   2. Multiple entries summing close to 1.0 — preserve as-is.
 *
 *   3. Multiple entries with shares interpreted as percentages (any single
 *      share > 1, or total > 1.5) — divide by 100 first, then validate.
 *
 *   4. Multiple entries whose normalized shares still don't sum to 1.0 —
 *      scale proportionally. Preserves the ratio the user intended while
 *      ensuring the manifest validates.
 */
function convertAttribution(
  v1_0: FairManifestV1_0,
): FairManifestV1_1['attribution'] {
  const entries = v1_0.attribution?.length ? v1_0.attribution : (v1_0.chain ?? []);

  // Filter out platform entries — platform belongs in chain, not attribution
  const filtered = entries.filter(e => e.role !== 'platform');

  // Case 1: single creator entry — creator gets 100% attribution (platform is in chain, not attribution)
  if (filtered.length === 1 && filtered[0].role === 'creator') {
    return [
      { did: v1_0.owner, role: 'creator', share: 1 },
    ];
  }

  if (filtered.length === 0) {
    return [
      { did: v1_0.owner, role: 'creator', share: 1 },
    ];
  }

  // Case 3: percentages-as-fractions — divide by 100.
  const rawSum = filtered.reduce((s, e) => s + (e.share ?? 0), 0);
  const looksLikePercentages = filtered.some((e) => (e.share ?? 0) > 1) || rawSum > 1.5;
  const scale = looksLikePercentages ? 100 : 1;

  const stage1 = filtered.map((e) => ({
    did: e.did,
    role: e.role,
    share: (e.share ?? 0) / scale,
    name: e.name,
    note: e.note,
    chainProof: e.chainProof,
  }));

  // Case 4: still not summing to 1.0 — scale proportionally.
  const stage1Sum = stage1.reduce((s, e) => s + e.share, 0);
  if (stage1Sum > 0 && Math.abs(stage1Sum - 1.0) > EPSILON) {
    return stage1.map((e) => ({ ...e, share: e.share / stage1Sum }));
  }

  // Case 2: shares already sum to 1.0 within tolerance.
  return stage1;
}

/**
 * Convert v1.0 distribution strings to v1.1 distribution rights.
 */
function convertDistribution(
  v1_0: FairManifestV1_0,
): NonNullable<FairManifestV1_1['distribution']> {
  const oldDist = (v1_0 as { distribution?: Record<string, string> }).distribution;
  const defaults = buildDefaults(v1_0.type, v1_0.owner);

  const toRight = (key: string): FairDistributionRight => {
    const mode = oldDist?.[key];
    if (mode && typeof mode === 'string') {
      return { mode };
    }
    return defaults.distribution[key as keyof typeof defaults.distribution] ?? { mode: 'reserved' };
  };

  return {
    reproduction: toRight('reproduction'),
    streaming: toRight('streaming'),
    derivative: toRight('derivative'),
    syndication: toRight('syndication'),
  };
}

/**
 * Upgrade a v1.0 manifest to v1.1.
 * Idempotent: passing an already-v1.1 manifest returns it unchanged.
 */
export function upgradeToV1_1(manifest: FairManifestV1_0 | FairManifestV1_1): FairManifestV1_1 {
  // Idempotency
  if ('version' in manifest && manifest.version === '1.1') {
    return manifest as FairManifestV1_1;
  }

  const v1_0 = manifest as FairManifestV1_0;
  const defaults = buildDefaults(v1_0.type, v1_0.owner);

  const upgraded: FairManifestV1_1 = {
    fair: '1.1',
    version: '1.1',
    id: v1_0.id,
    type: v1_0.type,
    owner: v1_0.owner,
    created: v1_0.created,
    source: v1_0.source ?? 'upgrade',
    access:
      typeof v1_0.access === 'string'
        ? v1_0.access
        : { ...(v1_0.access ?? { type: 'private' }) },
    attribution: convertAttribution(v1_0),
    distribution: convertDistribution(v1_0),
    transfer: v1_0.transfer
      ? {
          allowed: v1_0.transfer.allowed,
          requiresAttribution: true,
          price: defaults.transfer.price,
          resaleRoyaltyBps: defaults.transfer.resaleRoyaltyBps,
          refundable: v1_0.transfer.refundable,
          faceValueCap: v1_0.transfer.faceValueCap,
          resaleRoyalty: v1_0.transfer.resaleRoyalty,
        }
      : defaults.transfer,
    fees: v1_0.fees ?? defaults.fees,
    chain: v1_0.chain ?? defaults.chain,
    training: defaults.training,
    commercial: defaults.commercial,
    integrity: v1_0.integrity,
    terms: v1_0.terms,
    intent: v1_0.intent,
    tipping: defaults.tipping,
    // settlement is convention-driven; leave undefined on upgrade
  };

  // Apply type-aware overrides based on mimeType
  const bucket = mimeBucket(v1_0.type);
  if (bucket === 'text' && upgraded.distribution?.reproduction) {
    upgraded.distribution.reproduction.quote = { maxPercent: 25, maxWords: 200 };
  }
  if (bucket === 'audio' && upgraded.distribution?.derivative) {
    upgraded.distribution.derivative.sampling = { allowed: 'allow-with-share', share: 0.05 };
    upgraded.distribution.derivative.sync = { allowed: 'reserved' };
  }
  if (bucket === 'video' && upgraded.distribution?.derivative) {
    upgraded.distribution.derivative.sync = { allowed: 'reserved' };
  }

  return upgraded;
}
