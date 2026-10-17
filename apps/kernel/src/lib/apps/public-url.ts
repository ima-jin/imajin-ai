import { validateEntryUrl } from './entry-url';

/** Registry apps own their destinations; never infer a standalone app's port from SERVICES. */
export function registryAppPublicUrl(app: { slug: string; entryUrl: string | null }): string {
  const explicit = process.env[`NEXT_PUBLIC_${app.slug.toUpperCase()}_URL`];
  if (explicit) return explicit;
  if (app.entryUrl && validateEntryUrl(app.entryUrl).ok) return app.entryUrl;
  return `/${encodeURIComponent(app.slug)}`;
}
