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
    .replaceAll("\"", String.raw`\"`)
    .replaceAll("\n", String.raw`\n`)
    .replaceAll("\r", String.raw`\r`)
    .replaceAll("\t", String.raw`\t`);
  return `"${escaped}"`;
}

/**
 * Serialize a validated article block into a `---\n...\n---\n` YAML header.
 * Only defined fields are emitted, in a stable key order.
 */
export function serializeFrontmatter(article: ArticleBlock): string {
  const lines: string[] = ["---"];
  lines.push(`slug: ${yamlQuote(article.slug)}`, `title: ${yamlQuote(article.title)}`);
  if (article.subtitle !== undefined) lines.push(`subtitle: ${yamlQuote(article.subtitle)}`);
  if (article.description !== undefined) lines.push(`description: ${yamlQuote(article.description)}`);
  lines.push(`status: ${yamlQuote(article.status)}`, `date: ${yamlQuote(article.date)}`);
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

export interface FrontmatterSplit {
  /** The verbatim `---`-delimited header, byte-for-byte as it appears in the
   *  source (including any keys unknown to ArticleBlock). Empty string when
   *  there is no frontmatter. */
  header: string;
  /** Body with the header removed — identical to parseFrontmatter(...).body. */
  body: string;
  /** Parsed frontmatter key/values — identical to parseFrontmatter(...).data. */
  data: Record<string, unknown>;
}

/**
 * Split a markdown file into its verbatim frontmatter header and body,
 * without altering a single byte of the header (#1445).
 *
 * Viewers use this to hide the raw YAML from rendered/edited output while
 * still being able to reattach the ORIGINAL header unchanged when only the
 * body is edited — so unknown keys and key order always survive, even for
 * frontmatter that isn't a valid article. This never re-serializes; only the
 * structured metadata editor (routes/article.ts) writes YAML, via
 * serializeFrontmatter/composeArticleFile above.
 *
 * gray-matter's `content` is always an exact suffix of the input, so the
 * header is recovered by slicing off that many bytes from the start —
 * `header + body` therefore always reconstructs the original string exactly.
 */
export function splitFrontmatter(markdown: string): FrontmatterSplit {
  if (typeof markdown !== "string") return { header: "", body: "", data: {} };
  const { data, body } = parseFrontmatter(markdown);
  if (Object.keys(data).length === 0) return { header: "", body, data };
  return { header: markdown.slice(0, markdown.length - body.length), body, data };
}
