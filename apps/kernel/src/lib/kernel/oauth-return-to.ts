/**
 * Open-redirect guard for the connector OAuth `returnTo` round-trip (#1529).
 *
 * The connect route accepts `?returnTo=` so the callback can put the user back
 * on the page they launched the flow from. That value is attacker-influenced
 * (it rides in a URL), so it must never be allowed to point off-origin —
 * otherwise the kernel becomes an open-redirect gadget that lends its domain
 * to phishing.
 *
 * The rule is deliberately strict: a `returnTo` is either a *relative,
 * same-origin app path* or it is rejected outright. No hostname allowlist, no
 * absolute URLs, not even our own — a relative path can only ever resolve
 * against the current origin, which makes the guarantee structural rather than
 * a matter of getting a comparison right.
 *
 * Callers treat `null` as "no usable returnTo" and fall back to their default
 * landing page.
 */

/**
 * Validate a caller-supplied `returnTo` and return it, or `null` when it is
 * absent or not a safe same-origin app path.
 *
 * Rejected:
 *   - anything not starting with `/`            — `evil.com`, `../x`
 *   - protocol-relative `//host` and `/\host`   — browsers treat these as absolute
 *   - absolute URLs of any scheme               — `https://evil.com`, `javascript:…`
 *   - control characters (incl. CR/LF/TAB)      — header-splitting / filter-evasion
 *
 * Accepted: `/auth/connectors/quickbooks`, `/x?y=1#z`, `/`.
 */
export function sanitizeReturnTo(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;

  // Control characters (including CR/LF/TAB) are never legitimate in a path and
  // are the classic vector for smuggling past a naive prefix check.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(raw)) return null;

  // Must be a relative path...
  if (!raw.startsWith('/')) return null;

  // ...but `//host` and `/\host` are protocol-relative absolutes to a browser,
  // so a bare startsWith('/') check is not sufficient on its own.
  if (raw.startsWith('//') || raw.startsWith('/\\')) return null;

  return raw;
}
