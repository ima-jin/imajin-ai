// Relative (not "@/") so these modules resolve under the test runner, which
// loads the media libs for real rather than mocking them.
import { projectArticleFromFrontmatter } from "./article-core";

/**
 * Article frontmatter guard (#1542).
 *
 * `deriveArticleProjection` correctly returns `{ article: null }` for headerless
 * markdown — but on the write path that null was SILENT: an article-context
 * upload/update with no `---` YAML header just became a Lane 2 plain note with
 * no error and no warning (this shipped a headerless newsletter on 2026-08-01).
 *
 * This module does NOT change the projection. It only surfaces it: given the
 * incoming bytes plus the caller's context (or the asset's existing metadata),
 * it reports whether `metadata.article` is about to be null when the caller
 * clearly meant to write an article — so the write path can warn, or hard-reject
 * under `strict`.
 *
 * Plain notes (no article context, no existing `metadata.article`) never trip
 * this: they are supposed to project to null.
 */

/** Markdown is the only content class that carries article frontmatter. */
const MARKDOWN_MIME = "text/markdown";

/** `context.app` / `context.feature` values that declare article intent. */
const ARTICLE_CONTEXT_VALUES = new Set(["article", "articles"]);

/** Why `metadata.article` will be null. */
export type ArticleFrontmatterReason = "missing_frontmatter" | "invalid_frontmatter";

export interface ArticleFrontmatterCheck {
  /** Human-readable warning for the API response. */
  warning: string;
  /** Machine-readable cause. */
  reason: ArticleFrontmatterReason;
  /** True when the asset currently IS an article — i.e. this write demotes it. */
  demotes: boolean;
}

export interface ArticleFrontmatterCheckInput {
  /** Resolved MIME type of the asset being written. */
  mimeType: string;
  /** The incoming UTF-8 content. */
  content: string;
  /** Upload context supplied by the caller (POST /assets `context` field). */
  context?: unknown;
  /** Existing asset metadata (update path) — may carry `article` and/or `context`. */
  existingMetadata?: unknown;
}

/** True when an upload context object declares article intent. */
export function isArticleContext(context: unknown): boolean {
  if (!context || typeof context !== "object") return false;
  const { app, feature } = context as { app?: unknown; feature?: unknown };
  return [app, feature].some(
    (value) => typeof value === "string" && ARTICLE_CONTEXT_VALUES.has(value.trim().toLowerCase()),
  );
}

/** True when an asset's metadata already carries an article projection. */
export function hasArticleProjection(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object") return false;
  const { article } = metadata as { article?: unknown };
  return !!article && typeof article === "object";
}

/** True when an asset's stored `metadata.context` declares article intent. */
function metadataDeclaresArticleContext(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object") return false;
  return isArticleContext((metadata as { context?: unknown }).context);
}

function buildWarning(reason: ArticleFrontmatterReason, demotes: boolean, detail?: string): string {
  const cause =
    reason === "missing_frontmatter"
      ? "has no frontmatter title"
      : `has incomplete article frontmatter (${detail ?? "invalid"})`;

  if (demotes) {
    return (
      `DEMOTION: this write ${cause} but the asset is currently a live article — ` +
      "metadata.article will be null and it will STOP rendering as an article " +
      "(it becomes a plain note). Re-send the content with its --- YAML header to keep it an article."
    );
  }
  return `article-context markdown ${cause} — metadata.article will be null; asset will NOT render as an article`;
}

/**
 * Check whether a markdown write is about to silently produce a null article
 * projection despite article intent. Returns `null` when there is nothing to
 * warn about (non-markdown, plain note, or valid frontmatter).
 */
export function checkArticleFrontmatter(
  input: ArticleFrontmatterCheckInput,
): ArticleFrontmatterCheck | null {
  const { mimeType, content, context, existingMetadata } = input;
  if (mimeType !== MARKDOWN_MIME) return null;

  const demotes = hasArticleProjection(existingMetadata);
  const declaresArticle = isArticleContext(context) || metadataDeclaresArticleContext(existingMetadata);
  // No article intent anywhere → a plain note, which is SUPPOSED to project to
  // null. Never warn here (that would be a false positive on Lane 2 capture).
  if (!demotes && !declaresArticle) return null;

  const projected = projectArticleFromFrontmatter(content);
  if (projected !== null && !("error" in projected)) return null; // valid article — all good

  const reason: ArticleFrontmatterReason =
    projected === null ? "missing_frontmatter" : "invalid_frontmatter";
  const detail = projected === null ? undefined : projected.error;

  return { reason, demotes, warning: buildWarning(reason, demotes, detail) };
}

/**
 * Response fields for a write that tripped the guard. `articleProjection: null`
 * is the machine-readable flag callers branch on; `warning` is for humans.
 * Spreads to nothing when the check passed.
 */
export function articleWarningFields(
  check: ArticleFrontmatterCheck | null,
): { warning: string; articleProjection: null; articleWarningReason: ArticleFrontmatterReason } | Record<string, never> {
  if (!check) return {};
  return { warning: check.warning, articleProjection: null, articleWarningReason: check.reason };
}
