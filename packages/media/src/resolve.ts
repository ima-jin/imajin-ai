/**
 * Resolve a media asset ID to a content URL.
 *
 * Uses NEXT_PUBLIC_MEDIA_URL at build/runtime time.
 * Falls back to empty string so relative URLs still work in dev.
 */
export function resolveAssetUrl(assetId: string): string {
  const base = process.env.NEXT_PUBLIC_MEDIA_URL ?? '';
  return `${base}/api/assets/${assetId}`;
}

/**
 * Resolve a media reference that may be either a legacy URL/path or a new asset ID.
 *
 * - If ref starts with "asset_": treated as an asset ID → resolveAssetUrl
 * - Otherwise: returned as-is (already a full URL or relative path)
 *
 * Use this during the backward-compat transition period.
 */
export function resolveMediaRef(ref: string): string {
  if (ref.startsWith('asset_')) {
    return resolveAssetUrl(ref);
  }
  return ref;
}
