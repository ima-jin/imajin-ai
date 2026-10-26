/** Public, text-free descriptor carried by the signed run event. */
export type BriefStorage = 'full-text' | 'hash-only';
export interface WarpBrief {
  hash: string;
  assetId: string | null;
  storage: BriefStorage;
  browserTesting: 'yes' | 'no' | null;
}

export function isBriefStorage(value: unknown): value is BriefStorage {
  return value === 'full-text' || value === 'hash-only';
}

export function isWarpBrief(value: unknown): value is WarpBrief {
  if (!value || typeof value !== 'object') return false;
  const brief = value as WarpBrief;
  return typeof brief.hash === 'string' && /^[a-f0-9]{64}$/.test(brief.hash)
    && isBriefStorage(brief.storage)
    && (brief.browserTesting === null || brief.browserTesting === 'yes' || brief.browserTesting === 'no')
    && (brief.storage === 'hash-only' ? brief.assetId === null
      : typeof brief.assetId === 'string' && /^asset_[A-Za-z0-9_-]+$/.test(brief.assetId));
}

/** Missing flags stay unknown; telemetry is not a dispatch gate. */
export function browserTestingFlag(text: string): WarpBrief['browserTesting'] {
  return /^\s*Browser testing:\s*(yes|no)\b/im.exec(text)?.[1].toLowerCase() as WarpBrief['browserTesting'] ?? null;
}
