import { db, assets } from "@/src/db";
import { eq } from "drizzle-orm";
// Relative (not "@/") so it resolves under the test runner, which loads this
// module for real (only "@/src/db" is mocked).
import { parseFrontmatter } from "./frontmatter";

/**
 * Article domain core (#1170, #1193).
 *
 * Pure article validation/normalization plus the shared "re-derive the DB
 * projection from the file" helper. Extracted out of routes/article.ts so the
 * content-write path (update-asset.ts) can re-derive the projection without a
 * circular import (routes/article.ts → update-asset.ts → article-core.ts).
 *
 * Frontmatter in the `.md` file is the SOURCE OF TRUTH; `metadata.article` is a
 * derived projection used for fast listing and the public publish gate
 * (apps/kernel/src/lib/www/articles.ts).
 */

export const SLUG_REGEX = /^[a-z0-9-]+$/;
export const VALID_STATUSES = ["POSTED", "REVIEW", "DRAFT"] as const;
export type ArticleStatus = (typeof VALID_STATUSES)[number];

/** Raw article fields as received from a request body, tool args, or frontmatter. */
export interface ArticleInput {
  slug?: unknown;
  title?: unknown;
  subtitle?: unknown;
  description?: unknown;
  status?: unknown;
  date?: unknown;
  order?: unknown;
}

/** A validated, normalized article metadata block. */
export interface ArticleBlock {
  slug: string;
  title: string;
  subtitle?: string;
  description?: string;
  status: ArticleStatus;
  date: string;
  order?: number;
}

/**
 * Validate + normalize article fields into a metadata block. Returns the block
 * or a human-readable error (the exact messages the HTTP route surfaces).
 *
 * The default status is DRAFT (#1193): an agent (or any create-time caller that
 * omits status) must NOT publish straight to POSTED — promotion to POSTED is an
 * explicit act. An explicitly-supplied valid status (including POSTED) is
 * always preserved.
 */
export function buildArticleBlock(body: ArticleInput): { block: ArticleBlock } | { error: string } {
  if (!body.slug || typeof body.slug !== "string" || !SLUG_REGEX.test(body.slug)) {
    return { error: "slug is required and must be URL-safe (a-z, 0-9, hyphens only)" };
  }
  if (!body.title || typeof body.title !== "string" || !body.title.trim()) {
    return { error: "title is required" };
  }

  const status: ArticleStatus =
    body.status && VALID_STATUSES.includes(body.status as ArticleStatus)
      ? (body.status as ArticleStatus)
      : "DRAFT";

  const date =
    body.date && typeof body.date === "string"
      ? body.date
      : new Date().toISOString().split("T")[0];

  const order = typeof body.order === "number" ? body.order : undefined;

  const block: ArticleBlock = {
    slug: body.slug,
    title: body.title.trim(),
    subtitle: typeof body.subtitle === "string" ? body.subtitle.trim() : undefined,
    description: typeof body.description === "string" ? body.description.trim() : undefined,
    status,
    date,
    ...(order === undefined ? {} : { order }),
  };
  return { block };
}

/** Merge a validated article block into an asset's existing metadata object. */
export function mergeArticleMetadata(existing: unknown, block: ArticleBlock): Record<string, unknown> {
  const base = existing && typeof existing === "object" ? (existing as Record<string, unknown>) : {};
  return { ...base, article: block };
}

export interface DeriveArticleProjectionResult {
  /** The derived block when the file carries valid article frontmatter, else null (a plain note). */
  article: ArticleBlock | null;
}

/**
 * Re-derive `metadata.article` from a markdown file's frontmatter and persist
 * it. This is the single direction of truth: on create AND on every content
 * write, the file is parsed and the projection rebuilt — nobody updates the DB
 * row independently, so it cannot drift.
 *
 * Returns `{ article: null }` (and writes nothing) when the file has no valid
 * article frontmatter, i.e. a plain note. Adding article frontmatter to a note
 * via a later write therefore "promotes" it for free.
 */
export async function deriveArticleProjection(
  assetId: string,
  fileContent: string,
  existingMetadata: unknown,
): Promise<DeriveArticleProjectionResult> {
  const { data } = parseFrontmatter(fileContent);
  if (Object.keys(data).length === 0) return { article: null };

  const built = buildArticleBlock({
    slug: data.slug,
    title: data.title,
    subtitle: data.subtitle,
    description: data.description,
    status: data.status,
    date: data.date instanceof Date ? data.date.toISOString().split("T")[0] : data.date,
    order: data.order,
  });
  // No slug/title in the header → treat as a plain note, not an article.
  if ("error" in built) return { article: null };

  const metadata = mergeArticleMetadata(existingMetadata, built.block);
  await db.update(assets).set({ metadata, updatedAt: new Date() }).where(eq(assets.id, assetId));
  return { article: built.block };
}
