/**
 * Responsive article images (#1532).
 *
 * The media asset endpoint already resizes images on the fly — `GET
 * /media/api/assets/<id>?w=<px>` (see `serveAssetResponse` in serve-asset.ts,
 * step 3). Every `?w=` variant is a distinct URL with its own ETag and
 * `Cache-Control`, so the browser/CDN caches them independently.
 *
 * What was missing is the article reader *using* that capability: an inline
 * image was served at one fixed size to every device, so a phone on cellular
 * pulled the same ~1600px file as a retina desktop.
 *
 * This module is a post-render pass over the article body HTML. Any `<img>`
 * whose `src` points at the media asset endpoint is upgraded to a responsive
 * image (`srcset` + `sizes` + lazy loading). Everything else — external images,
 * images the author already gave a `srcset` — is left byte-for-byte untouched,
 * so the change is purely additive and hand-authored `<img>`/`<figure>` markup
 * keeps rendering exactly as before.
 *
 * NOTE ON THE QUERY PARAM: the resize param is `w`, not `width`. `?width=800`
 * is silently ignored by the endpoint and serves the full-size original, which
 * is why hand-authored `?width=` URLs *appear* to work. Emitting `w` is what
 * actually produces a resized variant.
 */

/** Widths (in CSS px) offered in the `srcset` ladder. */
export const RESPONSIVE_WIDTHS = [400, 800, 1200, 1600] as const;

/**
 * Width used for the plain `src` fallback. Mid-ladder: clients without
 * `srcset` support (and crawlers) get a reasonable file rather than the
 * smallest or the largest.
 */
export const FALLBACK_WIDTH = 800;

/**
 * `sizes` for the reader template. Keyed to `article { max-width: 680px }` in
 * `buildArticleHtml` — below that the image fills the viewport, above it the
 * content column is capped at 680px. Keep the two in sync.
 */
export const RESPONSIVE_SIZES = "(max-width: 680px) 100vw, 680px";

/** Inline style applied when the author has not supplied their own. */
const RESPONSIVE_STYLE = "max-width:100%;height:auto;";

/** Query params we own — stripped from the source URL before rebuilding. */
const WIDTH_PARAMS = new Set(["w", "width"]);

/**
 * Matches the asset-serving endpoint and nothing else: `/media/api/assets/<id>`
 * with no trailing sub-path (`/fair`, `/versions`, … are not images). Works for
 * absolute (`https://host/media/api/assets/x`), root-relative and
 * protocol-relative URLs alike.
 */
const MEDIA_ASSET_PATH_RE = /(?:^|\/)media\/api\/assets\/[^/]+$/;

/**
 * Matches a whole `<img>` tag, tolerating `>` inside quoted attribute values.
 * Group 1 is the raw attribute text.
 */
const IMG_TAG_RE = /<img\b((?:[^>"']|"[^"]*"|'[^']*')*)\/?>/gi;

/** Matches one HTML attribute: `name`, `name=value`, `name="value"`, `name='value'`. */
const ATTR_RE =
  /([^\s"'=/<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]*)))?/g;

interface ParsedAttribute {
  /** Attribute name as authored (case preserved for round-tripping). */
  readonly name: string;
  /** Lowercased name, for lookups. */
  readonly key: string;
  /** Raw (still entity-encoded) value, or `null` for a boolean attribute. */
  readonly value: string | null;
}

// ---------------------------------------------------------------------------
// Entity handling
// ---------------------------------------------------------------------------

/**
 * Decode the handful of entities a serializer emits inside an attribute value.
 * Deliberately minimal: this runs on URLs we are about to re-encode, not on
 * arbitrary prose.
 */
function decodeAttrValue(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#34;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&#38;", "&")
    .replaceAll("&amp;", "&");
}

/** Encode a value for use inside a double-quoted attribute. */
function encodeAttrValue(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

// ---------------------------------------------------------------------------
// Attribute parsing / serialization
// ---------------------------------------------------------------------------

function parseAttributes(raw: string): ParsedAttribute[] {
  const attrs: ParsedAttribute[] = [];
  ATTR_RE.lastIndex = 0;
  let match = ATTR_RE.exec(raw);
  while (match !== null) {
    const [, name, dq, sq, bare] = match;
    // A zero-length match would spin the loop forever; `+` on the name group
    // rules that out, but guard the index anyway.
    if (match.index === ATTR_RE.lastIndex) ATTR_RE.lastIndex += 1;
    if (name) {
      const value = dq ?? sq ?? bare ?? null;
      attrs.push({ name, key: name.toLowerCase(), value });
    }
    match = ATTR_RE.exec(raw);
  }
  return attrs;
}

function serializeAttributes(attrs: readonly ParsedAttribute[]): string {
  return attrs
    .map((a) => (a.value === null ? a.name : `${a.name}="${a.value}"`))
    .join(" ");
}

/** Replace an attribute's value in place, or append it when absent. */
function upsert(attrs: ParsedAttribute[], key: string, value: string): void {
  const encoded = encodeAttrValue(value);
  const existing = attrs.findIndex((a) => a.key === key);
  if (existing === -1) {
    attrs.push({ name: key, key, value: encoded });
    return;
  }
  attrs[existing] = { ...attrs[existing], value: encoded };
}

/** Append an attribute only when the author has not already set it. */
function fillIfAbsent(attrs: ParsedAttribute[], key: string, value: string): void {
  if (attrs.some((a) => a.key === key)) return;
  attrs.push({ name: key, key, value: encodeAttrValue(value) });
}

// ---------------------------------------------------------------------------
// Media asset URL handling
// ---------------------------------------------------------------------------

interface AssetUrlParts {
  /** URL up to (not including) the `?`. */
  readonly base: string;
  /** Surviving query params (width params removed), already `&`-joined, or "". */
  readonly query: string;
  /** Fragment including the leading `#`, or "". */
  readonly hash: string;
}

/**
 * Split a URL into asset parts when — and only when — it addresses the media
 * asset endpoint. Returns `null` for anything else (external hosts, other API
 * routes, data URIs), which is the signal to leave the tag alone.
 */
export function parseMediaAssetUrl(src: string): AssetUrlParts | null {
  const url = src.trim();
  if (!url) return null;
  // Whitespace and commas are the srcset separators — a URL containing either
  // cannot be expressed in a srcset candidate list, so don't try.
  if (/[\s,]/.test(url)) return null;

  const hashIndex = url.indexOf("#");
  const hash = hashIndex === -1 ? "" : url.slice(hashIndex);
  const withoutHash = hashIndex === -1 ? url : url.slice(0, hashIndex);

  const queryIndex = withoutHash.indexOf("?");
  const base = queryIndex === -1 ? withoutHash : withoutHash.slice(0, queryIndex);
  const rawQuery = queryIndex === -1 ? "" : withoutHash.slice(queryIndex + 1);

  if (!MEDIA_ASSET_PATH_RE.test(base)) return null;

  const query = rawQuery
    .split("&")
    .filter((pair) => pair !== "" && !WIDTH_PARAMS.has(pair.split("=")[0].toLowerCase()))
    .join("&");

  return { base, query, hash };
}

/** Build the URL for one width variant of an asset. */
export function buildVariantUrl(parts: AssetUrlParts, width: number): string {
  const query = parts.query ? `${parts.query}&w=${width}` : `w=${width}`;
  return `${parts.base}?${query}${parts.hash}`;
}

/** Build the `srcset` candidate list for an asset. */
export function buildSrcset(parts: AssetUrlParts): string {
  return RESPONSIVE_WIDTHS.map((w) => `${buildVariantUrl(parts, w)} ${w}w`).join(", ");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Rewrite every media-asset `<img>` in `html` into a responsive image.
 *
 * A tag is upgraded only when all of these hold:
 * - it has a `src`
 * - that `src` resolves to `/media/api/assets/<id>` (so `?w=` variants exist)
 * - it does not already carry a `srcset` (an explicit author opt-out)
 *
 * Untouched tags are returned verbatim. Existing attributes on upgraded tags
 * are preserved — `alt`, `class`, `title`, a hand-written `style`, and so on —
 * so hand-authored markup keeps its appearance and only gains the responsive
 * behaviour.
 */
export function rewriteResponsiveImages(html: string): string {
  if (!/<img\b/i.test(html)) return html;

  return html.replace(IMG_TAG_RE, (tag, rawAttrs: string) => {
    const attrs = parseAttributes(rawAttrs);

    // Author already declared candidates — respect that and bail.
    if (attrs.some((a) => a.key === "srcset")) return tag;

    const src = attrs.find((a) => a.key === "src")?.value;
    if (typeof src !== "string") return tag;

    const parts = parseMediaAssetUrl(decodeAttrValue(src));
    if (!parts) return tag;

    upsert(attrs, "src", buildVariantUrl(parts, FALLBACK_WIDTH));
    upsert(attrs, "srcset", buildSrcset(parts));
    upsert(attrs, "sizes", RESPONSIVE_SIZES);
    fillIfAbsent(attrs, "loading", "lazy");
    fillIfAbsent(attrs, "decoding", "async");
    fillIfAbsent(attrs, "style", RESPONSIVE_STYLE);

    return `<img ${serializeAttributes(attrs)} />`;
  });
}
