import { validateEntryUrl } from './entry-url';

/** Registry apps own their destinations; never infer a standalone app's port from SERVICES. */
export function registryAppPublicUrl(app: { slug: string; entryUrl: string | null }): string {
  if (app.entryUrl && validateEntryUrl(app.entryUrl).ok) return app.entryUrl;
  return `/${encodeURIComponent(app.slug)}`;
}

/**
 * API/profile paths may only be appended to a known app base, never to an
 * arbitrary entry destination (e.g. /app/start?campaign=launch).
 */
export function registryAppBaseUrl(app: { slug: string; entryUrl: string | null }): string | null {
  const entry = app.entryUrl;
  if (!entry || !validateEntryUrl(entry).ok || entry.includes('?') || entry.includes('#')) return null;
  const parsed = new URL(entry, 'https://registry.invalid');
  return parsed.pathname === '/' || parsed.pathname === `/${encodeURIComponent(app.slug)}` ? entry : null;
}
