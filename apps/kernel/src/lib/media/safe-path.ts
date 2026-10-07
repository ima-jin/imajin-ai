import path from "node:path";

/**
 * Helpers for treating user-supplied names as a single, safe path segment (#2681).
 *
 * User-controlled strings (asset display filenames, upload names) must never be
 * joined into a filesystem path unchecked: `../../x` escapes the owner folder and
 * `fs.rename` / `writeFile` silently overwrite whatever is at the destination.
 */

/** Longest filename we accept, in UTF-8 bytes (the common filesystem limit). */
export const MAX_FILENAME_BYTES = 255;

/** Longest file extension kept when deriving an on-disk name from an upload. */
const MAX_EXTENSION_LENGTH = 16;

const SAFE_EXTENSION = /^\.[A-Za-z0-9]+$/;

function hasControlChar(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    // C0 controls (includes NUL), DEL, and C1 controls.
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

export type FilenameCheck =
  | { ok: true; filename: string }
  | { ok: false; error: string };

/**
 * Validate a user-supplied filename as a single safe path segment.
 *
 * Trims surrounding whitespace, then rejects anything that is not a string,
 * is empty, is `.` / `..`, contains `/`, `\`, NUL or other control chars, or
 * is longer than {@link MAX_FILENAME_BYTES} bytes.
 */
export function validateFilename(raw: unknown): FilenameCheck {
  if (typeof raw !== "string" || !raw.trim()) {
    return { ok: false, error: "filename is required" };
  }
  const filename = raw.trim();
  if (filename === "." || filename === "..") {
    return { ok: false, error: "filename must not be '.' or '..'" };
  }
  if (filename.includes("/") || filename.includes("\\")) {
    return { ok: false, error: "filename must not contain path separators" };
  }
  if (hasControlChar(filename)) {
    return { ok: false, error: "filename must not contain control characters" };
  }
  if (Buffer.byteLength(filename, "utf8") > MAX_FILENAME_BYTES) {
    return { ok: false, error: `filename must be at most ${MAX_FILENAME_BYTES} bytes` };
  }
  return { ok: true, filename };
}

/**
 * Resolve `name` inside `baseDir` and return the absolute path, or `null` when
 * `name` is not a safe single segment or the result would leave `baseDir`.
 * The containment check compares against `baseDir + path.sep`, so a sibling
 * such as `/base-evil` never passes for `/base`.
 */
export function resolveInside(baseDir: string, name: string): string | null {
  if (!validateFilename(name).ok) return null;
  const base = path.resolve(baseDir);
  const target = path.resolve(base, name);
  return target.startsWith(base + path.sep) ? target : null;
}

/**
 * Extension (with leading dot) of an upload filename that is safe to append to
 * an on-disk name, or "" when it is missing or not plain alphanumerics.
 */
export function safeExtension(filename: string): string {
  const ext = path.extname(filename);
  return ext.length <= MAX_EXTENSION_LENGTH && SAFE_EXTENSION.test(ext) ? ext : "";
}
