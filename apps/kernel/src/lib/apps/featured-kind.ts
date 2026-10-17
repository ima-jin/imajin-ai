/** Shared with the operator panel without importing server-only execution code. */
export const APPS_FEATURED_KIND = 'apps:featured';

export interface AppFeaturedDetail {
  appDid: string;
  featured: boolean;
}

/** Both proposal ingestion and execution validate the untrusted payload. */
export function parseAppFeaturedDetail(value: unknown): AppFeaturedDetail | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const detail = value as Record<string, unknown>;
  if (typeof detail.appDid !== 'string' || detail.appDid.trim().length === 0) return null;
  if (typeof detail.featured !== 'boolean') return null;
  return { appDid: detail.appDid, featured: detail.featured };
}
