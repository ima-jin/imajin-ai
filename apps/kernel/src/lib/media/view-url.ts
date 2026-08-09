/**
 * Canonical human-viewable URL for a media asset (#1714).
 *
 * Every asset response independently knew the `{node}/media/api/assets/{id}`
 * URL pattern but never returned it, forcing callers to reconstruct it
 * themselves. This centralizes that construction so all asset responses
 * (upload, publish-as-article, get/list) expose the same `viewUrl`.
 *
 * Callers are responsible for resolving `baseUrl` first — the existing
 * convention across the media routes (see create-asset.ts, settle.ts,
 * media-share.ts) is:
 *   `process.env.NEXT_PUBLIC_BASE_URL || process.env.MEDIA_PUBLIC_URL || <request origin>`
 */
export function buildAssetViewUrl(baseUrl: string, assetId: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/media/api/assets/${assetId}`;
}
