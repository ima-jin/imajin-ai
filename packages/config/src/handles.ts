/**
 * Handle validation and normalization.
 *
 * Handles are node-scoped today, globally unique via DFOS chain in the future.
 * Pattern: lowercase alphanumeric + dots, hyphens, underscores. 3-30 chars.
 * No leading/trailing dots or hyphens. No consecutive dots or hyphens.
 */

/** Regex: the full allowed character set, length enforced */
export const HANDLE_PATTERN = /^[a-z0-9._-]{3,30}$/;

/** Regex: disallowed leading/trailing characters */
const HANDLE_EDGE = /^[.\-]|[.\-]$/;

/** Regex: consecutive dots or hyphens */
const HANDLE_CONSECUTIVE = /[.\-]{2}/;

/** HTML input pattern attribute (no anchors, no flags) */
export const HANDLE_INPUT_PATTERN = '[a-z0-9._\\-]{3,30}';

/** Characters allowed in handles — use in onChange filters */
export const HANDLE_ALLOWED_CHARS = /[^a-z0-9._-]/g;

/** Reserved handles that cannot be claimed */
export const RESERVED_HANDLES = new Set([
  'admin', 'api', 'app', 'auth', 'blog', 'coffee', 'connect', 'dashboard',
  'docs', 'edit', 'events', 'help', 'home', 'imajin', 'inbox', 'links', 'login',
  'logout', 'mail', 'news', 'pay', 'profile', 'register', 'search', 'settings',
  'signup', 'status', 'support', 'team', 'www',
]);

/** Validate handle format (does NOT check reserved or uniqueness) */
export function isValidHandle(handle: string): boolean {
  if (!HANDLE_PATTERN.test(handle)) return false;
  if (HANDLE_EDGE.test(handle)) return false;
  if (HANDLE_CONSECUTIVE.test(handle)) return false;
  return true;
}

/** Check if handle is reserved */
export function isReservedHandle(handle: string): boolean {
  return RESERVED_HANDLES.has(handle);
}

/** Normalize input: lowercase, strip disallowed chars */
export function normalizeHandleInput(value: string): string {
  return value.toLowerCase().replace(HANDLE_ALLOWED_CHARS, '');
}

/** Validation error message */
export const HANDLE_ERROR = 'Handle must be 3-30 characters: lowercase letters, numbers, dots, hyphens, underscores';
