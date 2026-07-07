import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { extname } from "node:path";
import { nanoid } from "nanoid";
import { eq, and, sql } from "drizzle-orm";
import { db, assets, folders, assetFolders, type Asset } from "@/src/db";
import { hexToBytes } from "@imajin/auth";
import { classifyAsset } from "@/src/lib/media/classify";
import { createLogger } from "@imajin/logger";
import { getDefaultManifest, signManifest, canonicalize } from "@imajin/fair";
import { publishContentEvent } from "@imajin/dfos";
import { computeCid } from "@imajin/cid";
import { blobStore } from "@/src/lib/media/blob-store-lore";
import { deriveArticleProjection, mergeArticleMetadata } from "@/src/lib/media/article-core";

const log = createLogger("kernel");

const MEDIA_ROOT = process.env.MEDIA_ROOT || "/mnt/media";

/** Context → system-folder mapping for auto-assignment on create. */
const CONTEXT_FOLDER_MAP: Record<string, { name: string; icon: string }> = {
  bugs: { name: "Bug Reports", icon: "🐛" },
  chat: { name: "Chat", icon: "💬" },
  profile: { name: "Profile", icon: "👤" },
  events: { name: "Events", icon: "🎫" },
  market: { name: "Profile", icon: "👤" },
  voice: { name: "Audio Recordings", icon: "🎙️" },
  signed: { name: "Signed Documents", icon: "📝" },
};

const ALLOWED_MIME_PREFIXES = ["image/", "audio/", "video/", "text/"];
const ALLOWED_MIME_EXACT = new Set(["application/pdf"]);

/** Map file extensions to MIME types for files browsers send as octet-stream. */
const EXT_TO_MIME: Record<string, string> = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".xml": "text/xml",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

/** Infer a usable MIME type from the browser-supplied type + filename. */
export function inferMime(browserMime: string, filename: string): string {
  if (browserMime && browserMime !== "application/octet-stream") {
    return browserMime;
  }
  const ext = /\.[a-z0-9]+$/.exec(filename.toLowerCase())?.[0] ?? "";
  return EXT_TO_MIME[ext] || browserMime || "application/octet-stream";
}

/** Allowlist check for stored MIME types. */
export function isAllowedMime(mime: string): boolean {
  if (ALLOWED_MIME_EXACT.has(mime)) return true;
  return ALLOWED_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix));
}

/** Replace chars that are unsafe on most filesystems. */
function didToPath(did: string): string {
  return did.replaceAll(":", "_").replaceAll(/[^a-zA-Z0-9._@-]/g, "_");
}

/** Upload context — auto-folder assignment + access override. */
export interface AssetContext {
  app?: string;
  feature?: string;
  entityId?: string;
  access?: string;
}

export interface CreateAssetInput {
  /** Owner DID the asset is pinned to. */
  ownerDid: string;
  /** Actual uploader DID (audit trail). Defaults to ownerDid when omitted. */
  uploadedBy?: string;
  /** Raw file bytes. */
  buffer: Buffer;
  /** Original filename (used for extension + display). */
  filename: string;
  /** Resolved MIME type (already inferred by the caller). */
  mimeType: string;
  /** Optional upload context (auto-folder + access inference). */
  context?: AssetContext | null;
  /**
   * Explicit access level override. Takes precedence over context-derived
   * access. MCP write tools pass 'private' so created assets never inherit a
   * public-implying app context.
   */
  access?: string;
  /** Base URL for the DFOS manifest anchor (falls back to env when omitted). */
  baseUrl?: string;
  /**
   * When true (HTTP upload), return an existing asset on content (CID/hash)
   * match. When false (MCP write tools), ALWAYS create a fresh, owner-pinned
   * asset with a new id + `.fair` — create-only semantics (#1170). Lore still
   * dedupes storage chunks transparently. Defaults to true.
   */
  dedup?: boolean;
  /** Run fire-and-forget classification after insert. Defaults to true. */
  classify?: boolean;
}

export interface CreateAssetResult {
  asset: Asset;
  /** True when an existing asset was returned instead of creating a new one. */
  deduplicated: boolean;
}

/** .fair access levels supported by the manifest template. */
type AccessType = "public" | "private" | "trust-graph" | "conversation";

/** Resolve the .fair access level (explicit override → context → app rule → private). */
function deriveAccessLevel(context: AssetContext | null | undefined, override?: string): AccessType {
  if (override) return override as AccessType;
  if (context?.access) return context.access as AccessType;
  const app = context?.app;
  if (app === "chat") return "conversation";
  if (app === "market" || app === "profile" || app === "events" || app === "www") return "public";
  return "private";
}

function resolveBaseUrl(explicit?: string): string {
  return explicit || process.env.NEXT_PUBLIC_BASE_URL || process.env.MEDIA_PUBLIC_URL || "";
}

/**
 * Create a media asset: content hashing + CID, optional dedup, signed `.fair`
 * manifest, local + Lore storage, DB row, DFOS anchor, auto-folder, and async
 * classification.
 *
 * Extracted from POST /media/api/assets (#1170) so both the HTTP upload route
 * and the in-process MCP write tools share one create path (mirrors the read
 * side's queries.ts / read-access.ts split). The route keeps HTTP concerns
 * (auth, multipart parse, tier/size limits, MIME inference); this owns the
 * create pipeline.
 */
/**
 * CID-first global dedup (then legacy hash+owner). Returns an existing active
 * asset if the same content was already stored, else null. Extracted to keep
 * createAsset under the cognitive-complexity bound.
 */
async function findDedupTarget(cid: string, hash: string, ownerDid: string): Promise<Asset | null> {
  const [existingByCid] = await db
    .select()
    .from(assets)
    .where(and(eq(assets.cid, cid), eq(assets.status, "active")))
    .limit(1);

  if (existingByCid) {
    if (existingByCid.ownerDid !== ownerDid) {
      log.info(
        { cid, originalOwner: existingByCid.ownerDid, newUploader: ownerDid, assetId: existingByCid.id },
        "Cross-DID dedup: provenance attributed to original creator (#1122 §2 — default-on, no opt-out in v1)",
      );
    }
    return existingByCid;
  }

  // Backward-compat: hash + owner dedup for pre-CID assets.
  const [existingByHash] = await db
    .select()
    .from(assets)
    .where(and(eq(assets.hash, hash), eq(assets.ownerDid, ownerDid), eq(assets.status, "active"), sql`${assets.cid} IS NULL`))
    .limit(1);

  return existingByHash ?? null;
}

/** Resolve (get-or-create, race-safe) a system folder id for the given name. */
async function getOrCreateSystemFolder(ownerDid: string, name: string, icon: string): Promise<string> {
  const [existing] = await db
    .select()
    .from(folders)
    .where(and(eq(folders.ownerDid, ownerDid), eq(folders.name, name), eq(folders.isSystem, true)))
    .limit(1);
  if (existing) return existing.id;

  const folderId = `folder_${nanoid(16)}`;
  const [inserted] = await db
    .insert(folders)
    .values({ id: folderId, ownerDid, name, icon, isSystem: true })
    .onConflictDoNothing()
    .returning();
  if (inserted) return folderId;

  // Lost the insert race — re-read.
  const [retry] = await db
    .select()
    .from(folders)
    .where(and(eq(folders.ownerDid, ownerDid), eq(folders.name, name), eq(folders.isSystem, true)))
    .limit(1);
  return retry?.id ?? folderId;
}

/** Auto-assign a freshly-created asset to a system folder based on context (non-fatal). */
async function autoAssignContextFolder(assetId: string, ownerDid: string, context: CreateAssetInput['context']): Promise<void> {
  const folderKey = context?.feature || context?.app || "";
  if (!folderKey) return;
  const folderConfig = CONTEXT_FOLDER_MAP[folderKey];
  if (!folderConfig) return;
  try {
    const folderId = await getOrCreateSystemFolder(ownerDid, folderConfig.name, folderConfig.icon);
    await db.insert(assetFolders).values({ assetId, folderId }).onConflictDoNothing();
  } catch (err) {
    log.error({ err: String(err) }, "Auto-folder assignment failed (non-fatal)");
  }
}

export async function createAsset(input: CreateAssetInput): Promise<CreateAssetResult> {
  const {
    ownerDid,
    buffer,
    filename,
    mimeType,
    context = null,
    dedup = true,
    classify = true,
  } = input;
  const uploadedBy = input.uploadedBy ?? ownerDid;

  // Defense-in-depth for non-HTTP callers (the route also 415s before this).
  if (!isAllowedMime(mimeType)) {
    throw new Error(`MIME type ${mimeType} is not allowed`);
  }

  const assetId = `asset_${nanoid(16)}`;
  const ext = extname(filename) || "";
  const size = buffer.byteLength;

  // SHA-256 (legacy identity) + CID (content-addressed identity, #1122 Layer A).
  const hash = createHash("sha256").update(buffer).digest("hex");
  const cid = await computeCid(new Uint8Array(buffer));

  // ── Dedup (HTTP upload only) ──────────────────────────────────────────────
  if (dedup) {
    const existing = await findDedupTarget(cid, hash, ownerDid);
    if (existing) {
      return { asset: existing, deduplicated: true };
    }
  }

  // Storage path: {MEDIA_ROOT}/{didPath}/assets/{assetId}{ext}
  const didPath = didToPath(ownerDid);
  const dirPath = `${MEDIA_ROOT}/${didPath}/assets`;
  const storagePath = `${dirPath}/${assetId}${ext}`;
  const fairPath = `${dirPath}/${assetId}.fair.json`;

  // .fair manifest — context-aware access, signed with the platform key.
  const accessLevel = deriveAccessLevel(context, input.access);
  const fairManifest = getDefaultManifest(mimeType, ownerDid);
  fairManifest.id = assetId;
  fairManifest.created = new Date().toISOString();
  fairManifest.access = { type: accessLevel };

  const platformDid = process.env.PLATFORM_DID;
  const platformKeyHex = process.env.AUTH_PRIVATE_KEY;
  let signedManifest = fairManifest;
  if (platformDid && platformKeyHex) {
    try {
      signedManifest = await signManifest(fairManifest, { did: platformDid, privateKey: hexToBytes(platformKeyHex) });
    } catch (err) {
      log.warn({ err: String(err) }, "Manifest signing failed, using unsigned manifest");
    }
  }

  try {
    await mkdir(dirPath, { recursive: true });
    await writeFile(storagePath, buffer);
    await writeFile(fairPath, JSON.stringify(signedManifest, null, 2));
  } catch (err) {
    log.error({ err: String(err) }, "Storage write failed");
    throw new Error(`Storage failure: ${String(err)}`);
  }

  // Register in Lore blob store (non-fatal).
  const blobRef = await blobStore
    .put(ownerDid, storagePath, { assetId, sizeBytes: size })
    .catch((err: unknown) => {
      log.error({ err: String(err), assetId }, "Lore blob store put failed (non-fatal)");
      return null;
    });

  let record: Asset;
  try {
    [record] = await db
      .insert(assets)
      .values({
        id: assetId,
        ownerDid,
        uploadedBy,
        filename,
        mimeType,
        size,
        storagePath,
        hash,
        fairManifest: signedManifest,
        fairPath,
        cid,
        loreRef: blobRef?.loreRef ?? null,
        versionCount: 1,
        status: "active",
        metadata: context ? { context } : {},
      })
      .returning();
  } catch (err) {
    log.error({ err: String(err) }, "DB insert failed");
    throw new Error(`Database failure: ${String(err)}`);
  }

  // Publish signed manifest to DFOS federation (best-effort, never blocks).
  const baseUrl = resolveBaseUrl(input.baseUrl);
  const manifestUrl = `${baseUrl}/media/api/assets/${assetId}/fair`;
  const manifestDigest = createHash("sha256").update(canonicalize(signedManifest)).digest("hex");
  try {
    const dfosResult = await publishContentEvent({
      topic: "fair.manifest.published",
      payload: {
        assetId,
        ownerDid,
        manifestDigest: `sha256:${manifestDigest}`,
        manifestUrl,
        fairVersion: (signedManifest as { fair?: string }).fair || "1.1",
        signedAt: new Date().toISOString(),
      },
    });
    if (dfosResult) {
      await db.update(assets).set({ fairDfosEventId: dfosResult.eventId }).where(eq(assets.id, assetId));
    }
  } catch (err) {
    log.error({ err: String(err), assetId }, "DFOS publish failed (non-fatal)");
  }

  // Auto-assign to a system folder based on context (non-fatal).
  await autoAssignContextFolder(assetId, ownerDid, context);

  // ── Article frontmatter projection (#1244) ──────────────────────────────
  // For markdown uploads, re-derive metadata.article from the file's YAML
  // frontmatter (source of truth, #1193). Safe to call unconditionally for
  // all .md files — the helper is a no-op when there is no valid article
  // header (plain notes). Runs before the classification block so
  // existingMeta already includes the article projection when classification
  // merges its result.
  if (mimeType === "text/markdown") {
    try {
      const fileContent = buffer.toString("utf8");
      const { article } = await deriveArticleProjection(assetId, fileContent, record.metadata);
      if (article !== null) {
        record = { ...record, metadata: mergeArticleMetadata(record.metadata, article) };
      }
    } catch (err) {
      log.error({ err: String(err), assetId }, "Article frontmatter projection failed (non-fatal)");
    }
  }

  // Fire-and-forget async classification.
  if (classify) {
    const existingMeta = record.metadata;
    classifyAsset(buffer, filename, mimeType)
      .then(async (result) => {
        await db
          .update(assets)
          .set({
            classification: result.category,
            classificationConfidence: Math.round(result.confidence * 100),
            metadata: { ...(typeof existingMeta === "object" && existingMeta !== null ? existingMeta : {}), classification: result },
          })
          .where(eq(assets.id, assetId));
      })
      .catch((err: unknown) => log.error({ err: String(err) }, "Classification failed"));
  }

  return { asset: record, deduplicated: false };
}
