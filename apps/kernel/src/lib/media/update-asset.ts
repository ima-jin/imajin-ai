import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { db, assets, type Asset } from "@/src/db";
import { eq, sql } from "drizzle-orm";
import type { FairManifest, FairManifestV1_1 } from "@imajin/fair";
import { isFairManifestV1_1 } from "@imajin/fair";
import { computeCid } from "@imajin/cid";
import { contentSigner } from "@/src/lib/media/content-signer";
import { blobStore } from "@/src/lib/media/blob-store-lore";
import { createLogger } from "@imajin/logger";
import { canWriteAssetContent } from "@/src/lib/media/write-access";
import { deriveArticleProjection } from "./article-core";
import { ensureProjectReactorRegistered } from "./projection-reactor";
import { publish } from "@imajin/bus";

const log = createLogger("kernel");

/**
 * Tracked *authored* document classes that may fire the document.changed
 * trigger (#1205, EPIC #1204). Human-cadence authored config/content only —
 * NEVER binary/other assets or machine-hot state (discipline rule 1). Editing
 * one of these IS the privileged control-plane action; the bus reacts
 * downstream (#1207).
 */
const AUTHORED_DOC_MIME_TYPES = new Set([
  "text/markdown",
  "text/yaml",
  "application/yaml",
  "application/x-yaml",
]);

/** Service scope for authored-document control-plane events. */
const DOCUMENT_CHANGED_SCOPE = "media";

export interface UpdateAssetContentInput {
  assetId: string;
  requesterDid: string;
  /** New UTF-8 text content (empty string is allowed — clears the file). */
  content: string;
  /**
   * Reject non-text assets (text/* or application/json) so a UTF-8 string write
   * cannot corrupt a binary asset. The HTTP route omits this to preserve its
   * existing behavior; the MCP tool sets it.
   */
  requireTextMime?: boolean;
}

export type UpdateAssetContentResult =
  | { ok: true; asset: Asset }
  | {
      ok: false;
      code: "not_found" | "forbidden" | "immutable" | "unsupported_media" | "storage_failed" | "db_failed";
      message: string;
    };

/**
 * Overwrite an asset's text content as a new version (#1170 Stage 2).
 *
 * Extracted verbatim from PUT /media/api/assets/[id]/content so the HTTP route
 * and the media_update MCP tool share one path. Authorization is OWNER-ONLY via
 * canWriteAssetContent (write-access.ts); the versioning semantics are
 * unchanged: new content hash + CID, a fresh Lore revision, a re-signed `.fair`
 * manifest, and versionCount + 1. The asset id (alias) is stable.
 */
export async function updateAssetContent(input: UpdateAssetContentInput): Promise<UpdateAssetContentResult> {
  const { assetId, requesterDid, content, requireTextMime = false } = input;

  let loaded: Asset | undefined;
  try {
    [loaded] = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
  } catch (err) {
    log.error({ err: String(err), assetId }, "DB lookup failed");
    return { ok: false, code: "db_failed", message: "Database failure" };
  }

  if (loaded?.status !== "active") {
    return { ok: false, code: "not_found", message: "Not found" };
  }
  const asset = loaded; // narrowed to Asset

  // Capture the CID BEFORE the write so document.changed can report the
  // prev→new transition (#1205).
  const prevCid = asset.cid ?? null;

  const decision = canWriteAssetContent({ ownerDid: asset.ownerDid, immutable: asset.immutable }, requesterDid);
  if (!decision.allowed) {
    return { ok: false, code: decision.code, message: decision.reason };
  }

  if (requireTextMime && !(asset.mimeType.startsWith("text/") || asset.mimeType === "application/json")) {
    return { ok: false, code: "unsupported_media", message: `Cannot update non-text content (${asset.mimeType})` };
  }

  try {
    await writeFile(asset.storagePath, content, "utf-8");
  } catch (err) {
    log.error({ err: String(err), assetId }, "File write failed");
    return { ok: false, code: "storage_failed", message: "File write failed" };
  }

  const hash = createHash("sha256").update(content).digest("hex");
  const size = Buffer.byteLength(content, "utf-8");

  // New CID for this version of the content (#1122 Bundle 3 — new CID per edit).
  const cid = await computeCid(new Uint8Array(Buffer.from(content, "utf-8")));

  // Register the new revision in Lore (non-fatal).
  const blobRef = await blobStore
    .put(asset.ownerDid, asset.storagePath, { assetId, sizeBytes: size })
    .catch((err: unknown) => {
      log.error({ err: String(err), assetId }, "Lore put after content edit failed (non-fatal)");
      return null;
    });

  // Re-sign the .fair manifest so the signature covers the current content state
  // (non-fatal: content is saved regardless).
  let updatedFairManifest = asset.fairManifest as Record<string, unknown> | undefined;
  const rawManifest = asset.fairManifest as FairManifest | null;
  if (rawManifest && isFairManifestV1_1(rawManifest)) {
    await contentSigner
      .sign(rawManifest as FairManifestV1_1)
      .then(async (signed) => {
        updatedFairManifest = signed as unknown as Record<string, unknown>;
        if (asset.fairPath) {
          await writeFile(asset.fairPath, JSON.stringify(signed, null, 2)).catch((err: unknown) =>
            log.warn({ err: String(err), assetId }, "Could not write re-signed .fair to disk (non-fatal)"),
          );
        }
      })
      .catch((err: unknown) =>
        log.warn({ err: String(err), assetId }, "Could not re-sign .fair after content edit (non-fatal)"),
      );
  }

  try {
    await db
      .update(assets)
      .set({
        hash,
        size,
        versionCount: sql`${assets.versionCount} + 1`,
        cid,
        loreRef: blobRef?.loreRef ?? asset.loreRef, // keep prior ref if Lore put failed
        fairManifest: updatedFairManifest ?? asset.fairManifest,
        updatedAt: new Date(),
      })
      .where(eq(assets.id, assetId));
  } catch (err) {
    log.error({ err: String(err), assetId }, "DB update failed");
    return { ok: false, code: "db_failed", message: "Database update failed" };
  }

  // Re-derive the article projection from the freshly written file. Frontmatter
  // is the source of truth (#1193): markdown-only, and a no-op for plain notes
  // (content with no article header). Best-effort — the file is authoritative, so
  // a projection failure self-heals on the next write rather than failing it.
  if (asset.mimeType === "text/markdown") {
    try {
      await deriveArticleProjection(assetId, content, asset.metadata);
    } catch (err) {
      log.warn({ err: String(err), assetId }, "Article projection re-derive failed (non-fatal)");
    }
  }

  // #1205 — authored-document change trigger. Editing a tracked authored doc
  // (markdown/YAML) IS the control-plane action: republish it on the bus so the
  // release-gated projection reactor (#1207) can run downstream. Owner-pinned is
  // already enforced above (canWriteAssetContent, owner-only). Gated to authored
  // doc classes ONLY — binary/other assets and machine-hot state never fire this
  // (discipline rule 1). Best-effort/non-fatal: the file is authoritative, so a
  // publish failure must not fail the write (mirrors asset.article.published).
  if (AUTHORED_DOC_MIME_TYPES.has(asset.mimeType)) {
    // Ensure the release-gated projection reactor (#1207) is registered in this
    // process before we publish, so publish() can run it in-process. Idempotent.
    ensureProjectReactorRegistered();
    try {
      await publish("document.changed", {
        issuer: asset.ownerDid,
        subject: assetId,
        scope: DOCUMENT_CHANGED_SCOPE,
        payload: { path: asset.storagePath, cid, prevCid },
      });
    } catch (err) {
      log.error({ err: String(err), assetId }, "document.changed publish failed (non-fatal)");
    }
  }

  const [updated] = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
  return { ok: true, asset: updated };
}
