import { eq } from 'drizzle-orm';
import { db, registryApps } from '@/src/db';
import { validateEntryUrl } from '@/src/lib/apps/entry-url';
import { nodeUrl } from '@/src/lib/http/node-url';

export interface OperationalApp {
  name: string;
  label: string;
  url: string;
  kind: 'core' | 'app';
}

// These are routes owned by the kernel, not a list of installed applications.
const CORE_ROUTES = [
  { name: 'www', label: 'Website', path: '/' },
  { name: 'auth', label: 'Auth', path: '/auth' },
  { name: 'pay', label: 'Payments', path: '/pay' },
  { name: 'profile', label: 'Profiles', path: '/profile' },
  { name: 'registry', label: 'Registry', path: '/registry' },
  { name: 'chat', label: 'Chat', path: '/chat' },
  { name: 'connections', label: 'Connections', path: '/connections' },
  { name: 'media', label: 'Media', path: '/media' },
  { name: 'notify', label: 'Notifications', path: '/notify' },
] as const;

/** Operational inventory only: registering an app never installs it in anyone's navigation. */
export async function listOperationalApps(): Promise<OperationalApp[]> {
  const origin = nodeUrl();
  const core: OperationalApp[] = CORE_ROUTES.map(({ name, label, path }) => ({
    name, label, url: new URL(path, origin).href, kind: 'core',
  }));
  const rows = await db.select({
    id: registryApps.id,
    slug: registryApps.slug,
    name: registryApps.name,
    entryUrl: registryApps.entryUrl,
    status: registryApps.status,
  }).from(registryApps).where(eq(registryApps.status, 'active'));

  const apps: OperationalApp[] = [];
  for (const row of rows) {
    if (row.status !== 'active' || !row.entryUrl || !validateEntryUrl(row.entryUrl).ok) continue;
    apps.push({
      name: row.slug ?? row.id,
      label: row.name,
      url: new URL(row.entryUrl, origin).href,
      kind: 'app',
    });
  }
  return [...core, ...apps];
}

/** Association hosts are registered destinations, never inferred `${slug}.${node}` hosts. */
export async function operationalAppOrigins(): Promise<string[]> {
  const apps = await listOperationalApps();
  return [...new Set(apps.map((app) => new URL(app.url).origin))];
}
