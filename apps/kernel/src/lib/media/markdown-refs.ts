/**
 * Markdown local-reference rewriting for bundle uploads (#2282).
 *
 * A bundle upload's index markdown authors image/link refs against the local
 * files it shipped alongside (`![diagram](./diagram.png)`,
 * `[report](report.pdf)`). Once those files are materialized as assets, the
 * index doc's refs must point at the real asset URLs — this module is the
 * single place that scans/rewrites those refs, shared by the bundle route so
 * the parsing logic has one owner and one test surface.
 */

/** Matches inline markdown links and images: `[text](ref)` / `![alt](ref)`. */
const MD_REF_RE = /(!?)\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/** A ref that was resolved to a materialized asset URL. */
export interface MarkdownRefRewrite {
  /** The original ref text as it appeared in the source markdown. */
  from: string;
  /** The resolved asset URL it was rewritten to. */
  to: string;
}

export interface RewriteMarkdownRefsResult {
  /** Markdown with every resolvable local ref replaced by its asset URL. */
  content: string;
  /** Refs that were resolved and rewritten. */
  rewritten: MarkdownRefRewrite[];
  /**
   * Local-looking refs that could not be resolved to a bundled file. These
   * are left as-is in `content` (there is nothing to rewrite them to) but are
   * always reported here — never silently left local without a signal.
   */
  unresolved: string[];
}

/** True for refs that are not local bundle-relative paths (nothing to resolve). */
function isExternalRef(ref: string): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:/i.test(ref) || // any scheme, e.g. https:, mailto:, data:
    ref.startsWith("//") ||
    ref.startsWith("#")
  );
}

/** Normalize a ref for path-map lookups: strip a leading `./` or `/`. */
export function normalizeLocalPath(path: string): string {
  return path.replace(/^\.\//, "").replace(/^\/+/, "");
}

/**
 * Rewrite every local (non-external) markdown ref in `markdown` using
 * `resolve`, which maps a normalized local path to an asset URL (or `null`
 * when unresolvable).
 */
export function rewriteMarkdownRefs(
  markdown: string,
  resolve: (normalizedLocalPath: string) => string | null,
): RewriteMarkdownRefsResult {
  const rewritten: MarkdownRefRewrite[] = [];
  const unresolved: string[] = [];
  const seenUnresolved = new Set<string>();

  const content = markdown.replaceAll(MD_REF_RE, (match: string, bang: string, label: string, ref: string) => {
    if (isExternalRef(ref)) return match;

    const resolvedUrl = resolve(normalizeLocalPath(ref));
    if (!resolvedUrl) {
      if (!seenUnresolved.has(ref)) {
        seenUnresolved.add(ref);
        unresolved.push(ref);
      }
      return match;
    }

    rewritten.push({ from: ref, to: resolvedUrl });
    return `${bang}[${label}](${resolvedUrl})`;
  });

  return { content, rewritten, unresolved };
}
