import type { LauncherEntry } from '@/src/lib/kernel/launcher';
import type { AppDirectoryApp } from '@/src/lib/kernel/app-nav';
import { getActingAsHeaders } from '@imajin/ui/server';
import { registryAppPublicUrl } from '@/src/lib/apps/public-url';

/** Same identity-scoped directory as Add app; private apps are never public catalog hints. */
export async function loadRegistryAppOptions(identityDid?: string): Promise<LauncherEntry[]> {
  const response = await fetch('/auth/api/apps/directory', {
    credentials: 'include',
    cache: 'no-store',
    headers: { ...getActingAsHeaders(), ...(identityDid && { 'X-Acting-As': identityDid }) },
  });
  if (!response.ok) throw new Error('Failed to load registry apps');
  const body = await response.json() as { apps?: AppDirectoryApp[] };
  return (body.apps ?? []).filter((app) => app.available).map((app) => ({
    name: app.slug,
    label: app.name,
    description: app.description ?? '',
    icon: app.icon ?? '🧩',
    category: 'core',
    visibility: 'public',
    source: 'registry',
    inherited: app.inherited,
    url: registryAppPublicUrl(app),
  }));
}
