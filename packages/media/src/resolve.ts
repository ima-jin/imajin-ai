/**
 * Media URL resolution with size presets.
 *
 * Uses NEXT_PUBLIC_MEDIA_URL at build/runtime time.
 * Falls back to empty string so relative URLs still work in dev.
 */

/** Named size presets for common display contexts */
export type MediaPreset = 'thumbnail' | 'card' | 'detail' | 'og' | 'original';

const PRESET_WIDTHS: Record<Exclude<MediaPreset, 'og' | 'original'>, number> = {
  thumbnail: 200,
  card: 400,
  detail: 800,
};

export function resolveAssetUrl(assetId: string, preset?: MediaPreset | number): string {
  const base = process.env.NEXT_PUBLIC_MEDIA_URL ?? '';
  const url = `${base}/api/assets/${assetId}`;

  if (!preset || preset === 'original') return url;
  if (preset === 'og') return `${url}/og`;
  if (typeof preset === 'number') return `${url}?w=${preset}`;
  return `${url}?w=${PRESET_WIDTHS[preset]}`;
}

/**
 * Resolve a media reference that may be either a legacy URL/path or a new asset ID.
 *
 * - If ref starts with "asset_": treated as an asset ID → resolveAssetUrl with preset
 * - Otherwise: returned as-is (already a full URL or relative path)
 *
 * @param ref - Asset ID (asset_xxx) or legacy URL
 * @param preset - Size preset name or explicit width in pixels
 *
 * Examples:
 *   resolveMediaRef("asset_xxx")              → full original URL
 *   resolveMediaRef("asset_xxx", "card")      → ?w=400
 *   resolveMediaRef("asset_xxx", "thumbnail") → ?w=200
 *   resolveMediaRef("asset_xxx", "detail")    → ?w=800
 *   resolveMediaRef("asset_xxx", "og")        → /og (1200×630 JPEG)
 *   resolveMediaRef("asset_xxx", 600)         → ?w=600
 *   resolveMediaRef("https://...", "card")    → "https://..." (unchanged)
 */
export function resolveMediaRef(ref: string, preset?: MediaPreset | number): string {
  if (ref.startsWith('asset_')) {
    return resolveAssetUrl(ref, preset);
  }
  return ref;
}
