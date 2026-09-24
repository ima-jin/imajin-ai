/**
 * SAFE interpolation renderer for data-driven notify templates (#1510).
 *
 * A `notify.templates` row is a config-plane value: once an admin surface
 * ships (explicit stretch goal, not built in this PR), an operator with
 * only DB/API access — not code review — could edit `subject_tpl` /
 * `body_tpl` / `html_tpl`. That makes the row's OWN literal content
 * untrusted right alongside the request-supplied `data` it interpolates.
 * This renderer treats both the same way: NOTHING in a template ever
 * becomes HTML except through one of the two token forms below, and there
 * is no code eval anywhere in this module.
 *
 * Token forms:
 *   - `{{fieldName}}`           — interpolates `data[fieldName]`.
 *   - `{{cta:fieldName:Label}}` — the ONLY structural element a template
 *     can produce: a fixed-markup CTA link/button. `data[fieldName]` is the
 *     href (validated as a safe absolute http(s) URL or a root-relative
 *     path — never `javascript:`/`data:`/any other scheme), `Label` is
 *     literal, escaped display text.
 *
 * `renderHtmlTemplate` escapes every character of the template that is not
 * part of a recognized token — including any literal `<`, `>`, `&`, or
 * quote an author typed — before substituting `{{field}}` values (also
 * escaped). There is no raw-HTML passthrough: an author cannot produce a
 * `<strong>`, an `<img>`, or any tag other than the whitelisted CTA anchor,
 * regardless of what they type in the row.
 *
 * `renderPlainTemplate` is for `subject_tpl` / `body_tpl` — plain-text
 * destinations (an in-app title/body, an email Subject header) that are
 * never interpreted as HTML. It still strips CR/LF from interpolated
 * values so a request-supplied field (e.g. a display name) cannot smuggle
 * extra header lines into an email Subject.
 */

const VAR_TOKEN = /\{\{\s*(\w+)\s*\}\}/g;
const CTA_TOKEN = /\{\{\s*cta:(\w+):([^{}]*)\}\}/g;

export type TemplateData = Record<string, unknown>;

/** Entity-escape a scalar for safe HTML text/attribute context. Non-scalars render as empty string. */
export function escapeHtml(value: unknown): string {
  const str = typeof value === "string" || typeof value === "number" ? String(value) : "";
  return str
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * True for an absolute `http(s)://` URL or a root-relative `/path` — the
 * only href shapes the whitelisted CTA construct will ever render. Rejects
 * `javascript:`, `data:`, protocol-relative `//`, and every other scheme.
 */
export function isSafeTemplateUrl(url: string): boolean {
  return /^https?:\/\//i.test(url) || (url.startsWith("/") && !url.startsWith("//"));
}

function scalarToString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

/** Defense in depth: a plain-text field must never carry a newline into a header (e.g. email Subject). */
function stripNewlines(value: string): string {
  return value.replaceAll(/[\r\n]+/g, " ");
}

/**
 * Render a plain-text field (`subject_tpl` / `body_tpl`). `{{field}}` only —
 * no CTA construct, no HTML escaping (the destination is plain text).
 */
export function renderPlainTemplate(template: string, data: TemplateData): string {
  return template.replaceAll(VAR_TOKEN, (_match, key: string) => stripNewlines(scalarToString(data[key])));
}

function renderCta(field: string, label: string, data: TemplateData): string {
  const raw = data[field];
  const url = typeof raw === "string" ? raw : "";
  if (!url || !isSafeTemplateUrl(url)) return "";
  const safeUrl = escapeHtml(url);
  const safeLabel = escapeHtml(label.trim());
  if (!safeLabel) return "";
  return `<a href="${safeUrl}" style="color:#f97316;text-decoration:none;font-weight:600;">${safeLabel} &rarr;</a>`;
}

/**
 * Render an HTML field (`html_tpl`). See the module doc for the full
 * threat model: every character outside the whitelisted `{{cta:...}}`
 * construct is escaped plain text, including the template's own literal
 * markup.
 */
export function renderHtmlTemplate(template: string, data: TemplateData): string {
  // `String.split` with a capturing global regex interleaves
  // [text, group1, group2, text, group1, group2, ..., text].
  const parts = template.split(CTA_TOKEN);
  let out = "";
  for (let i = 0; i < parts.length; i += 3) {
    const escapedText = escapeHtml(parts[i]);
    out += escapedText.replaceAll(VAR_TOKEN, (_match, key: string) => escapeHtml(data[key]));
    const field = parts[i + 1];
    const label = parts[i + 2];
    if (field === undefined) continue;
    out += renderCta(field, label ?? "", data);
  }
  return out;
}
