/**
 * Validation for the `entryUrl` an app manifest (`imajin.app.json`) publishes
 * and `apps.provision` writes onto its `registry.apps` row (#2434).
 *
 * The manifest lives in a third-party repo, so its `entryUrl` is untrusted
 * input that later flows into nav surfaces. Only two shapes are accepted:
 *  - a root-relative path (`/dykil`, `/dykil/home?x=1`), or
 *  - an absolute `https:` URL with a host and no embedded credentials.
 *
 * Everything else — `http:`, `javascript:`, `data:`, protocol-relative
 * (`//evil.example`), backslash tricks, bare hosts, empty strings — is
 * rejected with a clear error.
 */

const MAX_ENTRY_URL_LENGTH = 2048;
const MAX_ECHOED_LENGTH = 80;

const DEL_CODE = 0x7f;
const FIRST_PRINTABLE_CODE = 0x20;

/** Any ASCII control character (incl. tab/newline, which URL parsers silently strip). */
function isControlChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return code < FIRST_PRINTABLE_CODE || code === DEL_CODE;
}

function hasControlChars(value: string): boolean {
  return [...value].some(isControlChar);
}

export type EntryUrlValidation = { ok: true; value: string } | { ok: false; error: string };

function describeRejected(value: string): string {
  const printable = [...value].map((char) => (isControlChar(char) ? '?' : char)).join('');
  const echoed = printable.length > MAX_ECHOED_LENGTH ? `${printable.slice(0, MAX_ECHOED_LENGTH)}…` : printable;
  return JSON.stringify(echoed);
}

function reject(value: string, reason: string): EntryUrlValidation {
  return {
    ok: false,
    error: `Invalid manifest entryUrl ${describeRejected(value)}: ${reason}. entryUrl must be a root-relative path ("/app") or an https: URL.`,
  };
}

function isRootRelativePath(value: string): boolean {
  // "//host" is protocol-relative; "/\host" is treated like "//host" by browsers.
  return value.startsWith('/') && !value.startsWith('//') && !value.includes('\\');
}

function validateHttpsUrl(value: string): EntryUrlValidation {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return reject(value, 'not a parseable URL');
  }
  if (parsed.protocol !== 'https:') return reject(value, `scheme "${parsed.protocol}" is not allowed`);
  if (!parsed.hostname) return reject(value, 'missing host');
  if (parsed.username || parsed.password) return reject(value, 'credentials in the URL are not allowed');
  return { ok: true, value };
}

/** Validate a manifest `entryUrl` without throwing. */
export function validateEntryUrl(value: string): EntryUrlValidation {
  if (value.length === 0) return reject(value, 'empty');
  if (value.length > MAX_ENTRY_URL_LENGTH) return reject(value, `longer than ${MAX_ENTRY_URL_LENGTH} characters`);
  if (hasControlChars(value)) return reject(value, 'contains control characters');
  if (value.startsWith('//')) return reject(value, 'protocol-relative URLs are not allowed');
  if (isRootRelativePath(value)) return { ok: true, value };
  if (value.startsWith('/')) return reject(value, 'backslashes are not allowed in a path');
  return validateHttpsUrl(value);
}

/** Validate a manifest `entryUrl`, throwing an `Error` with a clear message when it is rejected. */
export function assertValidEntryUrl(value: string): string {
  const result = validateEntryUrl(value);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
