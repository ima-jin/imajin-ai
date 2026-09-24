import { nanoid } from "nanoid";
import { db, assetDocEdges } from "@/src/db";
import { createLogger } from "@imajin/logger";
import { createAsset, isAllowedMime, type AssetContext } from "@/src/lib/media/create-asset";
import { updateAssetContent } from "@/src/lib/media/update-asset";
import { checkArticleFrontmatter, type ArticleFrontmatterCheck } from "@/src/lib/media/article-guard";
import { buildAssetViewUrl } from "@/src/lib/media/view-url";
import { normalizeLocalPath, rewriteMarkdownRefs } from "@/src/lib/media/markdown-refs";

const log = createLogger("kernel");

/**
 * Bundle upload pipeline (#2282 item 4).
 *
 * POST /media/api/assets/bundle owns HTTP concerns (auth, multipart parse,
 * tier/size limits) and hands off to this module for the actual
 * materialize-then-rewrite pipeline, mirroring the create-asset.ts /
 * route.ts split for the single-file upload path.
 *
 * Pipeline (each step below is its own function to keep this file's
 * cognitive complexity in budget):
 *   0. checkIndexArticleGuard — article-frontmatter guard (#1542/#1870),
 *      evaluated on the RAW index content before anything is uploaded, so a
 *      strict rejection never orphans storage.
 *   1. materializeReferencedFiles — every non-index file is uploaded via the
 *      shared createAsset pipeline first, so the index doc can be rewritten
 *      against real asset URLs.
 *   2. rewriteIndexRefs — the index markdown's local refs (`![x](./pic.png)`)
 *      are rewritten to the matching asset's view URL. Refs that don't match
 *      any bundled file are left as-is but always reported in `unresolved` —
 *      never silently left local without a signal.
 *   3. materializeIndex — created fresh (dedup-on, so re-uploading an
 *      unchanged bundle returns the same ids), or updated in place when the
 *      caller passes `indexAssetId` (explicit update semantics).
 *   4. recordDocAssetEdges — a `media.asset_doc_edges` row per referenced
 *      asset so .fair derivative tracking can walk "what does this doc
 *      embed" without re-parsing markdown.
 */

export interface BundleFileInput {
  /** Relative path as authored in the bundle (matches refs in the index doc). */
  path: string;
  buffer: Buffer;
  mimeType: string;
}

export interface BundleUploadInput {
  ownerDid: string;
  uploadedBy: string;
  files: BundleFileInput[];
  /** `path` of the file in `files` that is the markdown entry point. */
  indexPath: string;
  /**
   * When provided, the index is updated in place (same asset id preserved)
   * instead of created fresh. Update semantics (#2282 acceptance): re-upload
   * a bundle against the same index id and it re-materializes rather than
   * forking a new asset.
   */
  indexAssetId?: string;
  context?: AssetContext | null;
  /** Hard-reject (400) instead of warn when the frontmatter guard trips. */
  strict?: boolean;
  baseUrl: string;
}

export interface BundleAssetSummary {
  path: string;
  id: string;
  url: string;
  hash: string;
}

export type BundleUploadResult =
  | {
      ok: true;
      assets: BundleAssetSummary[];
      index: { id: string; url: string };
      rewritten: { from: string; to: string }[];
      unresolved: string[];
      articleWarning: ArticleFrontmatterCheck | null;
    }
  | { ok: false; status: number; error: string };

type StepFailure = { ok: false; status: number; error: string };
type StepResult<T> = { ok: true; value: T } | StepFailure;

function basenameOf(path: string): string {
  return path.split("/").pop() || path;
}

/** Step 0 — see module doc. Returns the (possibly null) warning, or a strict rejection. */
function checkIndexArticleGuard(
  isMarkdownIndex: boolean,
  rawIndexContent: string,
  context: AssetContext | null,
  indexAssetId: string | undefined,
  strict: boolean,
): StepResult<ArticleFrontmatterCheck | null> {
  if (!isMarkdownIndex || indexAssetId) return { ok: true, value: null };

  const check = checkArticleFrontmatter({ mimeType: "text/markdown", content: rawIndexContent, context });
  if (check && strict) return { ok: false, status: 400, error: check.warning };
  return { ok: true, value: check };
}

/** Step 1 — see module doc. */
async function materializeReferencedFiles(
  files: BundleFileInput[],
  opts: { ownerDid: string; uploadedBy: string; context: AssetContext | null; baseUrl: string },
): Promise<StepResult<{ assets: BundleAssetSummary[]; pathToUrl: Map<string, string> }>> {
  const assets: BundleAssetSummary[] = [];
  const pathToUrl = new Map<string, string>();

  for (const file of files) {
    if (!isAllowedMime(file.mimeType)) {
      return { ok: false, status: 415, error: `MIME type ${file.mimeType} is not allowed for ${file.path}` };
    }

    let created;
    try {
      created = await createAsset({
        ownerDid: opts.ownerDid,
        uploadedBy: opts.uploadedBy,
        buffer: file.buffer,
        filename: basenameOf(file.path),
        mimeType: file.mimeType,
        context: opts.context,
        baseUrl: opts.baseUrl,
      });
    } catch (err) {
      log.error({ err: String(err), path: file.path }, "Bundle asset creation failed");
      return { ok: false, status: 500, error: `Storage failure for ${file.path}: ${String(err)}` };
    }

    const url = buildAssetViewUrl(opts.baseUrl, created.asset.id);
    assets.push({ path: file.path, id: created.asset.id, url, hash: created.asset.hash });
    pathToUrl.set(normalizeLocalPath(file.path), url);
  }

  return { ok: true, value: { assets, pathToUrl } };
}

/** Step 2 — see module doc. */
function rewriteIndexRefs(isMarkdownIndex: boolean, rawIndexContent: string, pathToUrl: Map<string, string>) {
  return isMarkdownIndex
    ? rewriteMarkdownRefs(rawIndexContent, (localPath) => pathToUrl.get(localPath) ?? null)
    : { content: rawIndexContent, rewritten: [] as { from: string; to: string }[], unresolved: [] as string[] };
}

/** Step 3 — see module doc. */
async function materializeIndex(input: {
  indexFile: BundleFileInput;
  rewrittenContent: string;
  indexAssetId: string | undefined;
  createPathWarning: ArticleFrontmatterCheck | null;
  ownerDid: string;
  uploadedBy: string;
  context: AssetContext | null;
  strict: boolean;
  baseUrl: string;
}): Promise<StepResult<{ id: string; articleWarning: ArticleFrontmatterCheck | null }>> {
  const { indexFile, rewrittenContent, indexAssetId, createPathWarning, ownerDid, uploadedBy, context, strict, baseUrl } =
    input;

  if (indexAssetId) {
    const updated = await updateAssetContent({
      assetId: indexAssetId,
      requesterDid: ownerDid,
      content: rewrittenContent,
      strict,
    });
    if (!updated.ok) return { ok: false, status: 400, error: updated.message };
    return { ok: true, value: { id: updated.asset.id, articleWarning: updated.articleWarning } };
  }

  try {
    const created = await createAsset({
      ownerDid,
      uploadedBy,
      buffer: Buffer.from(rewrittenContent, "utf8"),
      filename: basenameOf(indexFile.path),
      mimeType: indexFile.mimeType,
      context,
      baseUrl,
    });
    return { ok: true, value: { id: created.asset.id, articleWarning: createPathWarning } };
  } catch (err) {
    log.error({ err: String(err), path: indexFile.path }, "Bundle index creation failed");
    return { ok: false, status: 500, error: `Storage failure for index: ${String(err)}` };
  }
}

/** Step 4 — see module doc. Non-fatal: logged and swallowed per edge. */
async function recordDocAssetEdges(docAssetId: string, assetIds: readonly string[]): Promise<void> {
  for (const assetId of assetIds) {
    try {
      await db
        .insert(assetDocEdges)
        .values({ id: `edge_${nanoid(16)}`, docAssetId, assetId, relation: "embeds" })
        .onConflictDoNothing();
    } catch (err) {
      log.error({ err: String(err), docAssetId, assetId }, "Doc-asset edge recording failed (non-fatal)");
    }
  }
}

export async function processBundleUpload(input: BundleUploadInput): Promise<BundleUploadResult> {
  const { ownerDid, uploadedBy, files, indexPath, indexAssetId, context = null, strict = false, baseUrl } = input;

  const indexFile = files.find((f) => f.path === indexPath);
  if (!indexFile) {
    return { ok: false, status: 400, error: `index file "${indexPath}" not found in bundle` };
  }
  const referencedFiles = files.filter((f) => f.path !== indexPath);
  const isMarkdownIndex = indexFile.mimeType === "text/markdown";
  const rawIndexContent = indexFile.buffer.toString("utf8");

  const guard = checkIndexArticleGuard(isMarkdownIndex, rawIndexContent, context, indexAssetId, strict);
  if (!guard.ok) return guard;

  const materializedRefs = await materializeReferencedFiles(referencedFiles, { ownerDid, uploadedBy, context, baseUrl });
  if (!materializedRefs.ok) return materializedRefs;
  const { assets: assetSummaries, pathToUrl } = materializedRefs.value;

  const { content: rewrittenContent, rewritten, unresolved } = rewriteIndexRefs(
    isMarkdownIndex,
    rawIndexContent,
    pathToUrl,
  );

  const materializedIndex = await materializeIndex({
    indexFile,
    rewrittenContent,
    indexAssetId,
    createPathWarning: guard.value,
    ownerDid,
    uploadedBy,
    context,
    strict,
    baseUrl,
  });
  if (!materializedIndex.ok) return materializedIndex;
  const { id: indexAssetIdResolved, articleWarning } = materializedIndex.value;

  await recordDocAssetEdges(
    indexAssetIdResolved,
    assetSummaries.map((a) => a.id),
  );

  return {
    ok: true,
    assets: assetSummaries,
    index: { id: indexAssetIdResolved, url: buildAssetViewUrl(baseUrl, indexAssetIdResolved) },
    rewritten,
    unresolved,
    articleWarning,
  };
}
