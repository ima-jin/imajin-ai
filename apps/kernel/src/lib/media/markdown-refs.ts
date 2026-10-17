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

/** Next matching character at each offset, built once rather than rescanning malformed links. */
function nextPositions(text: string, matches: (character: string) => boolean): Uint32Array {
  const positions = new Uint32Array(text.length + 1);
  let next = text.length;
  positions[text.length] = next;
  for (let index = text.length - 1; index >= 0; index--) {
    if (matches(text[index])) next = index;
    positions[index] = next;
  }
  return positions;
}

interface InlineRef {
  start: number;
  end: number;
  labelEnd: number;
  refStart: number;
  refEnd: number;
}
interface RefBoundaries {
  urlEnds: Uint32Array;
  nonWhitespace: Uint32Array;
  quotes: Uint32Array;
}

/** Recognize the existing optional quoted-title syntax without any backtracking. */
function referenceEnd(
  text: string,
  refEnd: number,
  nonWhitespace: Uint32Array,
  quotes: Uint32Array,
): number | null {
  if (text[refEnd] === ')') return refEnd + 1;
  const titleStart = nonWhitespace[refEnd];
  if (titleStart === refEnd || text[titleStart] !== '"') return null;
  const titleEnd = quotes[titleStart + 1];
  return text[titleEnd + 1] === ')' ? titleEnd + 2 : null;
}
function inlineRefAt(
  text: string,
  opening: number,
  labelEnd: number,
  boundaries: RefBoundaries,
): InlineRef | null {
  if (opening < 0 || text[labelEnd + 1] !== '(') return null;
  const refStart = labelEnd + 2;
  const refEnd = boundaries.urlEnds[refStart];
  if (refEnd === undefined || refEnd === refStart) return null;
  const end = referenceEnd(text, refEnd, boundaries.nonWhitespace, boundaries.quotes);
  if (end === null) return null;
  const start = text[opening - 1] === '!' ? opening - 1 : opening;
  return { start, end, labelEnd, refStart, refEnd };
}

/**
 * Scan `[text](ref)` / `![alt](ref)` in linear time, including malformed input.
 * Cached boundaries prevent repeated `[` or `](` from rescanning a shared tail.
 */
function* inlineRefs(text: string): Generator<InlineRef> {
  const boundaries: RefBoundaries = {
    urlEnds: nextPositions(text, (character) => /[)\s"]/.test(character)),
    nonWhitespace: nextPositions(text, (character) => !/\s/.test(character)),
    quotes: nextPositions(text, (character) => character === '"'),
  };
  let labelStart = -1;

  for (let index = 0; index < text.length; index++) {
    if (text[index] === '[' && labelStart < 0) labelStart = index;
    if (text[index] !== ']') continue;
    const match = inlineRefAt(text, labelStart, index, boundaries);
    labelStart = -1;
    if (match === null) continue;
    yield match;
    index = match.end - 1;
  }
}

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

  const parts: string[] = [];
  let previousEnd = 0;
  for (const match of inlineRefs(markdown)) {
    const ref = markdown.slice(match.refStart, match.refEnd);
    if (isExternalRef(ref)) continue;

    const resolvedUrl = resolve(normalizeLocalPath(ref));
    if (!resolvedUrl) {
      if (!seenUnresolved.has(ref)) {
        seenUnresolved.add(ref);
        unresolved.push(ref);
      }
      continue;
    }

    rewritten.push({ from: ref, to: resolvedUrl });
    parts.push(markdown.slice(previousEnd, match.start));
    parts.push(`${markdown.slice(match.start, match.labelEnd + 1)}(${resolvedUrl})`);
    previousEnd = match.end;
  }
  parts.push(markdown.slice(previousEnd));
  const content = parts.join('');

  return { content, rewritten, unresolved };
}
