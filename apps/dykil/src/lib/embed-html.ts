/**
 * Matches an opening/closing HTML tag name, used by the survey embed page's
 * `applyHtmlHandler` to allowlist a small set of safe formatting tags.
 *
 * Both character classes rely on the trailing `i` flag for
 * case-insensitivity, so the `A-Z` range is dropped (S5869: keeping it would
 * duplicate what `a-z` already matches case-insensitively) rather than
 * doubled up as `[a-zA-Z]`.
 */
export const HTML_TAG_PATTERN = /<\/?([a-z][a-z0-9]*)\b[^>]*>/gi;
