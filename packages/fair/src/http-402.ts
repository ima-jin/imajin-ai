import type { FairManifestV1_1, SettlementScheme } from './types';

export type FairAction = 'reproduction' | 'streaming' | 'derivative' | 'syndication';

export interface Build402ResponseOpts {
  manifest: FairManifestV1_1;
  assetId: string;
  action: FairAction;
  supportedSchemes: SettlementScheme[];
  baseUrl: string;
  schemeUrls?: Partial<Record<SettlementScheme, string>>;
}

export interface Fair402Response {
  status: 402;
  headers: Record<string, string>;
  body: {
    error: 'payment_required';
    assetId: string;
    action: FairAction;
    price: {
      amount: number;
      currency: string;
    };
    splits?: Array<{
      did?: string;
      role: string;
      share: number;
      name?: string;
    }>;
    settlement: {
      endpoint: string;
      schemes: SettlementScheme[];
      fallback?: SettlementScheme;
      urls?: Partial<Record<SettlementScheme, string>>;
    };
  };
}

/**
 * Build a 402 Payment Required response per the .fair settlement spec.
 *
 * Pure function — no I/O. Caller injects scheme-specific URLs.
 *
 * @throws if the requested action has no price (caller should not reach here)
 */
export function build402Response(opts: Build402ResponseOpts): Fair402Response {
  const { manifest, assetId, action, supportedSchemes, baseUrl, schemeUrls } = opts;

  const dist = manifest.distribution?.[action];
  if (!dist?.price) {
    throw new Error(`Action "${action}" has no price in manifest distribution`);
  }

  // Intersection of what the node supports and what the manifest allows
  const manifestSchemes = manifest.settlement?.schemes;
  const effectiveSchemes = manifestSchemes
    ? supportedSchemes.filter((s) => manifestSchemes.includes(s))
    : supportedSchemes;

  if (effectiveSchemes.length === 0) {
    throw new Error(`No supported settlement schemes overlap with manifest allowed schemes`);
  }

  const settlementEndpoint = manifest.settlement?.endpoint || `${baseUrl}/${assetId}/settle`;
  const fallback = manifest.settlement?.fallback;

  // Build X-Settle-* headers for each available scheme
  const headers: Record<string, string> = {
    'Content-Type': 'application/fair+json',
    'Link': `<${baseUrl}/${assetId}/fair>; rel="fair"`,
    'X-Settle-Endpoint': settlementEndpoint,
  };

  for (const scheme of effectiveSchemes) {
    const headerKey = `X-Settle-${schemeToHeader(scheme)}`;
    const url = schemeUrls?.[scheme];
    if (url) {
      headers[headerKey] = url;
    } else {
      // Placeholder — caller may not have pre-built URLs for all schemes
      headers[headerKey] = 'pending';
    }
  }

  const body: Fair402Response['body'] = {
    error: 'payment_required',
    assetId,
    action,
    price: {
      amount: dist.price.amount,
      currency: dist.price.currency,
    },
    ...(dist.splits ? { splits: dist.splits } : {}),
    settlement: {
      endpoint: settlementEndpoint,
      schemes: effectiveSchemes,
      ...(fallback ? { fallback } : {}),
      ...(schemeUrls ? { urls: schemeUrls } : {}),
    },
  };

  return { status: 402, headers, body };
}

function schemeToHeader(scheme: SettlementScheme): string {
  // x402 → X-402, stripe-link → Stripe, etc.
  return scheme
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}
