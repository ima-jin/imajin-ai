import matter from "gray-matter";
// Relative (not "@/") so the module resolves under the test runner, which loads
// these media modules for real rather than mocking them.
import type { ArticleBlock } from "./article-core";

/**
 * Frontmatter codec for markdown articles (#1193).
 *
 * The `.md` file's `---` YAML header is the SOURCE OF TRUTH; the DB
 * `metadata.article` row is a derived projection. These helpers keep the file
 * self-describing and round-trip safe with the www read path, which parses the
 * same files with `gray-matter` (apps/kernel/src/lib/www/articles.ts).
 *
 * We hand-roll serialization (rather than `matter.stringify`) so every string
 * value is emitted as a double-quoted YAML scalar. That guarantees fields like
 * `date: "2026-06-29"` round-trip back as STRINGS — js-yaml (gray-matter's
 * engine) would otherwise coerce an unquoted ISO date into a `Date` object.
 */

/** Escape + double-quote a string as a YAML flow scalar. */
function yamlQuote(value: string): string {
  const escaped = value
    .replaceAll("\\", "\\\\")
    .replaceAll("\"", "\\\"")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t");
  return `"${escaped}"`;
}

/**
 * Serialize a validated article block into a `---\n...\n---\n` YAML header.
 * Only defined fields are emitted, in a stable key order.
 */
export function serializeFrontmatter(article: ArticleBlock): string {
  const lines: string[] = ["---"];
  lines.push(`slug: ${yamlQuote(article.slug)}`);
  lines.push(`title: ${yamlQuote(article.title)}`);
  if (article.subtitle !== undefined) lines.push(`subtitle: ${yamlQuote(article.subtitle)}`);
  if (article.description !== undefined) lines.push(`description: ${yamlQuote(article.description)}`);
  lines.push(`status: ${yamlQuote(article.status)}`);
  lines.push(`date: ${yamlQuote(article.date)}`);
  if (article.order !== undefined) lines.push(`order: ${article.order}`);
  lines.push("---");
  return `${lines.join("\n")}\n`;
}

export interface ParsedFrontmatter {
  /** Raw frontmatter key/values (empty object when there is no header). */
  data: Record<string, unknown>;
  /** The markdown body with the frontmatter header removed. */
  body: string;
}

/**
 * Parse frontmatter out of a markdown string. Backed by `gray-matter` so it
 * matches the www read path. Malformed YAML is treated as "no frontmatter"
 * (the whole input becomes the body) rather than throwing.
 */
export function parseFrontmatter(markdown: string): ParsedFrontmatter {
  if (typeof markdown !== "string") return { data: {}, body: "" };
  try {
    const parsed = matter(markdown);
    return {
      data: (parsed.data ?? {}) as Record<string, unknown>,
      body: parsed.content ?? "",
    };
  } catch {
    return { data: {}, body: markdown };
  }
}

/**
 * Compose a complete article file: the YAML frontmatter header followed by the
 * body. Leading blank lines on the body are dropped so repeated writes don't
 * accumulate whitespace.
 */
export function composeArticleFile(article: ArticleBlock, body: string): string {
  const header = serializeFrontmatter(article);
  const trimmedBody = body.replace(/^\n+/, "");
  return trimmedBody.length > 0 ? `${header}\n${trimmedBody}` : header;
}
