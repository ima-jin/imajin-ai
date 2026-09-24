import type { ArticleFrontmatterCheck } from "./article-guard";

/**
 * Compact upload response (#2282 item 5): `?compact=1` (HTTP), `quiet: true`
 * (MCP `media_upload`). Trades the verbose response (storagePath, fairManifest,
 * createdAt, …) for a minimal payload a caller can log or forward cheaply.
 * `warning` is included so the article-frontmatter guard (#1542/#1870) still
 * surfaces even in compact form (#2282 item 6) — omitted entirely when there
 * is nothing to warn about, so a clean upload's compact response stays as
 * small as possible.
 */
export interface CompactAssetResponse {
  id: string;
  url: string;
  hash: string;
  size: number;
  mimeType: string;
  warning?: string;
}

export function buildCompactAssetResponse(
  asset: { id: string; hash: string; size: number; mimeType: string },
  url: string,
  articleWarning?: ArticleFrontmatterCheck | null,
): CompactAssetResponse {
  return {
    id: asset.id,
    url,
    hash: asset.hash,
    size: asset.size,
    mimeType: asset.mimeType,
    ...(articleWarning ? { warning: articleWarning.warning } : {}),
  };
}
