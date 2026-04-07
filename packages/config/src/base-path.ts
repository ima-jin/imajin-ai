/**
 * basePath-aware utilities for userspace apps running behind Next.js basePath.
 *
 * Next.js `basePath` auto-prefixes <Link> and router.push() but NOT:
 *   - fetch() calls
 *   - <a href=""> tags
 *   - window.location assignments
 *
 * These utilities read NEXT_PUBLIC_BASE_PATH (set automatically by Next.js
 * when basePath is configured) and prepend it where needed.
 *
 * Usage:
 *   import { apiFetch, apiUrl } from '@imajin/config';
 *
 *   // Instead of: fetch('/api/listings')
 *   apiFetch('/api/listings')
 *
 *   // For <a> tags or window.location:
 *   <a href={apiUrl('/dashboard')}>Dashboard</a>
 *   window.location.href = apiUrl('/dashboard');
 */

/**
 * Get the basePath prefix. Works in both browser and server contexts.
 * Returns empty string when no basePath is configured (standalone mode).
 */
function getBasePath(): string {
  return process.env.NEXT_PUBLIC_BASE_PATH || '';
}

/**
 * Prepend basePath to any root-relative path.
 *
 *   apiUrl('/api/listings')  → '/market/api/listings'  (with basePath: '/market')
 *   apiUrl('/dashboard')     → '/market/dashboard'
 *   apiUrl('/api/listings')  → '/api/listings'          (standalone, no basePath)
 */
export function apiUrl(path: string): string {
  const base = getBasePath();
  if (!base) return path;
  // Avoid double-prefixing
  if (path.startsWith(base)) return path;
  return `${base}${path}`;
}

/**
 * basePath-aware fetch wrapper. Drop-in replacement for fetch() with
 * root-relative paths.
 *
 *   apiFetch('/api/listings')           → fetch('/market/api/listings')
 *   apiFetch('/api/listings', { ... })  → fetch('/market/api/listings', { ... })
 *
 * Absolute URLs (http://, https://) are passed through unchanged.
 */
export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  // Don't prefix absolute URLs
  if (path.startsWith('http://') || path.startsWith('https://')) {
    return fetch(path, init);
  }
  return fetch(apiUrl(path), init);
}
