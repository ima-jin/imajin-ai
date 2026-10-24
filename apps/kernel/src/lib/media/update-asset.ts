import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { db, assets, attestations, type Asset } from "@/src/db";
import { eq, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import type { FairManifest, FairManifestV11 } from "@imajin/fair";
import { isFairManifestV11 } from "@imajin/fair";
import { computeCid } from "@imajin/cid";
import { contentSigner } from "@/src/lib/media/content-signer";
import { blobStore } from "@/src/lib/media/blob-store-lore";
import { createLogger } from "@imajin/logger";
import { canWriteAssetContent } from "@/src/lib/media/write-access";
import { deriveArticleProjection } from "./article-core";
import { checkArticleFrontmatter, type ArticleFrontmatterCheck } from "./article-guard";
import { ensureProjectReactorRegistered } from "./projection-reactor";
import { ensureChannelLinksSurfaceRegistered } from "./channel-links-surface";
import { publish } from "@imajin/bus";
import { isLegalEntityAsset, signLegalEntityDocument, prepareLegalEntityChange } from "./control-document";
import { LegalEntityValidationError } from "../profile/legal-entity-schema";
import { parseLegalEntity } from "../profile/legal-entity-document";

const log = createLogger("kernel");

/** Human-cadence authored config/content only — never binary or machine-hot state (#1205). */
const AUTHORED_DOC_MIME_TYPES = new Set([
  "text/markdown", "text/yaml", "application/yaml", "application/x-yaml",
]);

export interface UpdateAssetContentInput {
  /** Internal owner-settings rail only; generic media writes cannot change this record. */
  controlDocument?: 'legal-entity';
  composedBy?: string;
  assetId: string;
  requesterDid: string;
  /** New UTF-8 text content (empty string is allowed for ordinary assets). */
  content: string;
  /** Reject binary assets rather than corrupting them with a UTF-8 write. */
  requireTextMime?: boolean;
  /** Opt-in hard rejection for an article-frontmatter demotion (#1542). */
  strict?: boolean;
  /** Acting delegate's app DID (token azp), attribution only (#2366). */
  appDid?: string;
}

export type UpdateAssetContentResult =
  | { ok: true; asset: Asset; articleWarning: ArticleFrontmatterCheck | null }
  | {
      ok: false;
      code:
        | "not_found" | "forbidden" | "immutable" | "unsupported_media"
        | "storage_failed" | "db_failed" | "article_frontmatter_required"
        | "invalid_document" | "signing_failed";
      message: string;
    };
type UpdateFailure = Extract<UpdateAssetContentResult, { ok: false }>;
type LegalRevision = {
  ok: true;
  manifest?: FairManifestV11;
  change?: Awaited<ReturnType<typeof prepareLegalEntityChange>>;
  revoked: boolean;
};

/** Ordinary media preserves its best-effort signing semantics. Legal records never use this fallback. */
async function resignFairManifest(asset: Asset, assetId: string): Promise<Record<string, unknown> | undefined> {
  const current = asset.fairManifest as Record<string, unknown> | undefined;
  const rawManifest = asset.fairManifest as FairManifest | null;
  if (!rawManifest || !isFairManifestV11(rawManifest)) return current;
  try {
    const signed = await contentSigner.sign(rawManifest as FairManifestV11);
    if (asset.fairPath) await mirrorFairToDisk(asset.fairPath, signed, assetId);
    return signed as unknown as Record<string, unknown>;
  } catch (err: unknown) {
    log.warn({ err: String(err), assetId }, "Could not re-sign .fair after content edit (non-fatal)");
    return current;
  }
}

/** The signed in-DB copy is authoritative if mirroring its sidecar fails. */
async function mirrorFairToDisk(fairPath: string, signed: unknown, assetId: string): Promise<void> {
  try {
    await writeFile(fairPath, JSON.stringify(signed, null, 2));
  } catch (err: unknown) {
    log.warn({ err: String(err), assetId }, "Could not write re-signed .fair to disk (non-fatal)");
  }
}

function guardArticleUpdate(asset: Asset, content: string, assetId: string): ArticleFrontmatterCheck | null {
  const check = checkArticleFrontmatter({
    mimeType: asset.mimeType, content, existingMetadata: asset.metadata,
  });
  if (check) {
    log.warn(
      { assetId, reason: check.reason, demotes: check.demotes },
      "Article projection will be null for an article-context markdown write",
    );
  }
  return check;
}

async function loadWritableAsset(input: UpdateAssetContentInput): Promise<{ ok: true; asset: Asset } | UpdateFailure> {
  const { assetId, requesterDid, requireTextMime = false } = input;
  let asset: Asset | undefined;
  try {
    [asset] = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
  } catch (err) {
    log.error({ err: String(err), assetId }, "DB lookup failed");
    return { ok: false, code: "db_failed", message: "Database failure" };
  }
  if (asset?.status !== "active") return { ok: false, code: "not_found", message: "Not found" };
  const legalEntity = isLegalEntityAsset(asset.metadata);
  if (legalEntity && input.controlDocument !== 'legal-entity') {
    return { ok: false, code: "forbidden", message: "Use legal-entity settings to edit or revoke this document" };
  }
  const decision = canWriteAssetContent({
    ownerDid: asset.ownerDid, immutable: legalEntity ? false : asset.immutable,
  }, requesterDid);
  if (!decision.allowed) return { ok: false, code: decision.code, message: decision.reason };
  if (requireTextMime && !(asset.mimeType.startsWith("text/") || asset.mimeType === "application/json")) {
    return { ok: false, code: "unsupported_media", message: `Cannot update non-text content (${asset.mimeType})` };
  }
  return { ok: true, asset };
}

/** Legal revisions require schema validation, content-bound signing AND a durable state-change attestation. */
async function prepareLegalRevision(asset: Asset, input: UpdateAssetContentInput): Promise<LegalRevision | UpdateFailure> {
  if (!isLegalEntityAsset(asset.metadata)) return { ok: true, revoked: false };
  const { content, requesterDid } = input;
  try {
    const revoked = parseLegalEntity(content, asset.ownerDid).input === null;
    const composedBy = input.composedBy ?? requesterDid;
    const manifest = await signLegalEntityDocument(
      asset.fairManifest as FairManifestV11, content, asset.ownerDid, composedBy,
    );
    const change = await prepareLegalEntityChange(asset.id, asset.ownerDid, composedBy, content, asset.hash);
    return { ok: true, manifest, change, revoked };
  } catch (err) {
    return {
      ok: false,
      code: err instanceof LegalEntityValidationError ? "invalid_document" : "signing_failed",
      message: err instanceof LegalEntityValidationError ? err.message : "Document signing failed",
    };
  }
}

async function persistRevision(assetId: string, values: PgUpdateSetSource<typeof assets>, legal: LegalRevision): Promise<void> {
  if (legal.change) {
    const change = legal.change;
    await db.transaction(async tx => {
      await tx.update(assets).set(values).where(eq(assets.id, assetId));
      await tx.insert(attestations).values(change);
    });
  } else {
    await db.update(assets).set(values).where(eq(assets.id, assetId));
  }
}

async function deriveUpdatedArticle(asset: Asset, content: string): Promise<void> {
  if (asset.mimeType !== "text/markdown" || isLegalEntityAsset(asset.metadata)) return;
  try {
    await deriveArticleProjection(asset.id, content, asset.metadata);
  } catch (err) {
    log.warn({ err: String(err), assetId: asset.id }, "Article projection re-derive failed (non-fatal)");
  }
}

async function publishDocumentChange(asset: Asset, cid: string, appDid?: string): Promise<void> {
  if (!AUTHORED_DOC_MIME_TYPES.has(asset.mimeType)) return;
  // Keep the #1205/#1208 event rail. Legal documents are explicitly excluded
  // by projectReactor; connector surfaces retain their own document gates.
  ensureProjectReactorRegistered();
  ensureChannelLinksSurfaceRegistered();
  try {
    await publish("document.changed", {
      issuer: asset.ownerDid,
      subject: asset.id,
      scope: "media",
      payload: {
        path: asset.storagePath, cid, prevCid: asset.cid ?? null,
        ...(appDid ? { appDid } : {}),
      },
    });
  } catch (err) {
    log.error({ err: String(err), assetId: asset.id }, "document.changed publish failed (non-fatal)");
  }
}

/**
 * Shared owner-only content write (#1170): a stable asset alias, new content
 * hash/CID, Lore revision, re-signed .fair and versionCount + 1. Legal control
 * records additionally validate before write and atomically retain a signed
 * change attestation alongside the new DB state; deletion is a signed
 * value-free tombstone plus status=deleted, never row/history destruction.
 */
export async function updateAssetContent(input: UpdateAssetContentInput): Promise<UpdateAssetContentResult> {
  const { assetId, content, strict = false, appDid } = input;
  const loaded = await loadWritableAsset(input);
  if (!loaded.ok) return loaded;
  const { asset } = loaded;
  const articleWarning = guardArticleUpdate(asset, content, assetId);
  if (articleWarning && strict) {
    return { ok: false, code: "article_frontmatter_required", message: articleWarning.warning };
  }
  const legal = await prepareLegalRevision(asset, input);
  if (!legal.ok) return legal;

  try {
    await writeFile(asset.storagePath, content, "utf-8");
  } catch (err) {
    log.error({ err: String(err), assetId }, "File write failed");
    return { ok: false, code: "storage_failed", message: "File write failed" };
  }
  const hash = createHash("sha256").update(content).digest("hex");
  const size = Buffer.byteLength(content, "utf-8");
  const cid = await computeCid(new Uint8Array(Buffer.from(content, "utf-8")));
  const blobRef = await blobStore.put(asset.ownerDid, asset.storagePath, { assetId, sizeBytes: size })
    .catch((err: unknown) => {
      log.error({ err: String(err), assetId }, "Lore put after content edit failed (non-fatal)");
      return null;
    });
  const updatedFairManifest = legal.manifest ?? await resignFairManifest(asset, assetId);
  if (legal.manifest && asset.fairPath) await mirrorFairToDisk(asset.fairPath, legal.manifest, assetId);
  try {
    await persistRevision(assetId, {
      hash, size, versionCount: sql`${assets.versionCount} + 1`, cid,
      loreRef: blobRef?.loreRef ?? asset.loreRef,
      fairManifest: updatedFairManifest ?? asset.fairManifest,
      updatedAt: new Date(),
      ...(legal.revoked ? { status: "deleted" } : {}),
    }, legal);
  } catch (err) {
    log.error({ err: String(err), assetId }, "DB update failed");
    return { ok: false, code: "db_failed", message: "Database update failed" };
  }
  await deriveUpdatedArticle(asset, content);
  await publishDocumentChange(asset, cid, appDid);
  const [updated] = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
  return { ok: true, asset: updated, articleWarning };
}
