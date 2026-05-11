import type { FairManifestV1_0, FairManifestV1_1, FairDistributionRight, Money } from './types';

const PLATFORM_DID = 'did:imajin:platform';

function asDistributionRight(mode: string): FairDistributionRight {
  return { mode };
}

function mimeBucket(mimeType: string): 'text' | 'image' | 'audio' | 'video' | 'other' {
  if (mimeType.startsWith('text/')) return 'text';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  return 'other';
}

function buildDefaults(mimeType: string): {
  distribution: NonNullable<FairManifestV1_1['distribution']>;
  transfer: NonNullable<FairManifestV1_1['transfer']>;
  training: NonNullable<FairManifestV1_1['training']>;
  commercial: NonNullable<FairManifestV1_1['commercial']>;
  fees: NonNullable<FairManifestV1_1['fees']>;
  tipping: NonNullable<FairManifestV1_1['tipping']>;
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

  return {
    distribution,
    transfer: { allowed: true, requiresAttribution: true, price: transferPrice, resaleRoyaltyBps: 500 },
    training: { allowed: false },
    commercial: { allowed: false, contactRequired: true },
    fees,
    tipping: { enabled: true },
  };
}

/**
 * Convert a DidShareList from v1.0 attribution/chain format.
 * If the v1.0 attribution only has the owner, we apply the new 99/1 default.
 * Otherwise we preserve all entries and normalize shares if they sum > 1.
 */
function convertAttribution(
  v1_0: FairManifestV1_0,
): FairManifestV1_1['attribution'] {
  const entries = v1_0.attribution?.length ? v1_0.attribution : (v1_0.chain ?? []);

  // If only a single creator entry with share=1.0, apply the new 99/1 default
  if (
    entries.length === 1 &&
    entries[0].role === 'creator' &&
    entries[0].share === 1.0
  ) {
    return [
      { did: v1_0.owner, role: 'creator', share: 0.99 },
      { role: 'platform', name: 'Imajin', share: 0.01 },
    ];
  }

  // Otherwise preserve existing entries (they may not sum to 1.0, but that's user data)
  return entries.map((e) => ({
    did: e.did,
    role: e.role,
    share: e.share,
    name: e.name,
    note: e.note,
    chainProof: e.chainProof,
  }));
}

/**
 * Convert v1.0 distribution strings to v1.1 distribution rights.
 */
function convertDistribution(
  v1_0: FairManifestV1_0,
): NonNullable<FairManifestV1_1['distribution']> {
  const oldDist = v1_0.distribution as Record<string, string> | undefined;
  const defaults = buildDefaults(v1_0.type);

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
  const defaults = buildDefaults(v1_0.type);

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
