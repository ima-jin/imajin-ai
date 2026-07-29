import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { canonicalize } from "@imajin/fair";
import type { FairManifest } from "@imajin/fair";
import type { Asset } from "@/src/db";

/**
 * Resolve the `.fair` manifest for an asset.
 *
 * Prefers the DB-stored copy (`asset.fairManifest`) when it is a non-empty
 * object; falls back to reading the sidecar file from disk (`asset.fairPath`).
 * Returns null when no manifest can be found (treated as `access: "private"`
 * by callers).
 *
 * Extracted from the inline block in GET /media/api/assets/[id] as part of
 * the family-① Sonar sweep (issue #1467).
 */
export async function resolveManifest(asset: Asset): Promise<FairManifest | null> {
  if (
    asset.fairManifest &&
    typeof asset.fairManifest === "object" &&
    Object.keys(asset.fairManifest as object).length > 0
  ) {
    return asset.fairManifest as FairManifest;
  }

  if (asset.fairPath) {
    try {
      const raw = await readFile(asset.fairPath, "utf-8");
      return JSON.parse(raw) as FairManifest;
    } catch {
      // No manifest on disk — caller treats null as private
    }
  }

  return null;
}

/**
 * Build the `.fair` sidecar response headers for an asset.
 *
 * Attaches a `Link` rel=fair header pointing at the manifest endpoint, plus
 * optional `X-Fair-Digest` (sha256 of the canonical manifest) and
 * `X-Fair-Dfos` (the DFOS event id) headers.
 */
export function buildFairHeaders(
  assetId: string,
  manifest: FairManifest | null,
  dfosEventId: string | null,
): Record<string, string> {
  const headers: Record<string, string> = {};
  headers["Link"] = `</media/api/assets/${assetId}/fair>; rel="fair"; type="application/fair+json"`;

  if (manifest) {
    const digest = createHash("sha256").update(canonicalize(manifest)).digest("hex");
    headers["X-Fair-Digest"] = `sha256:${digest}`;
  }

  if (dfosEventId) {
    headers["X-Fair-Dfos"] = `dfos:event:${dfosEventId}`;
  }

  return headers;
}
