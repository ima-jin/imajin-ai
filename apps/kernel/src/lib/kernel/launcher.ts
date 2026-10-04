/**
 * Launcher / landing-grid listing (#2434).
 *
 * The landing grid used to list EVERY tile from `packages/config`'s static
 * `SERVICES` array (via `/registry/api/specs`), so an app that exists only as
 * a `registry.apps` row never appeared. The tile SET is now:
 *  - kernel-native + project (`meta`) tiles from `SERVICES` — these are
 *    infrastructure that is never pruned and has no registry row, and
 *  - every registry app declaring the `launcher` placement
 *    (`resolveLauncherApps`, the same resolver the identity-scoped nav uses).
 *
 * `SERVICES` is still consulted for PRESENTATION HINTS only (description,
 * visibility, grouping) when a registry slug happens to have a matching
 * entry; a registry-only app gets neutral defaults. It never decides whether
 * an app is listed.
 */
import { SERVICES, buildPublicUrl, getService } from '@imajin/config';
import type { ServiceVisibility, ServiceCategory } from '@imajin/config';
import { resolveLauncherApps, type NavApp } from './app-nav';

/** Categories that stay driven by `SERVICES`: not extractable apps, never pruned. */
const STATIC_LAUNCHER_CATEGORIES: ReadonlySet<ServiceCategory> = new Set<ServiceCategory>(['kernel', 'meta']);

export interface LauncherEntry {
  name: string;
  description: string;
  icon: string;
  label: string;
  visibility: ServiceVisibility;
  category: ServiceCategory;
  url: string;
  externalUrl?: string;
  /** `registry` entries are subject to per-identity narrowing by the grid; `static` ones are always listed. */
  source: 'static' | 'registry';
}

const DEFAULT_APP_ICON = '🧩';

function staticEntries(): LauncherEntry[] {
  return SERVICES.filter((s) => STATIC_LAUNCHER_CATEGORIES.has(s.category)).map((s) => {
    const url = buildPublicUrl(s.name);
    const isExternal = Boolean(s.externalUrl || s.wwwPath);
    return {
      name: s.name,
      description: s.description,
      icon: s.icon,
      label: s.label,
      visibility: s.visibility,
      category: s.category,
      url,
      ...(isExternal && { externalUrl: url }),
      source: 'static' as const,
    };
  });
}

function registryEntry(app: NavApp): LauncherEntry {
  const hint = getService(app.slug);
  return {
    name: app.slug,
    description: hint?.description ?? app.name,
    icon: app.icon ?? hint?.icon ?? DEFAULT_APP_ICON,
    label: app.name,
    visibility: hint?.visibility ?? 'public',
    category: hint?.category ?? 'core',
    url: buildPublicUrl(app.slug),
    source: 'registry',
  };
}

/** Static kernel/project tiles plus one tile per registry app on the `launcher` placement. */
export async function buildLauncherEntries(): Promise<LauncherEntry[]> {
  const apps = await resolveLauncherApps();
  return [...staticEntries(), ...apps.map(registryEntry)];
}
