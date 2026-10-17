import { redirect, notFound } from 'next/navigation';
import { registryAppPublicUrl } from '@/src/lib/apps/public-url';
import { getEffectiveDid } from '../lib/get-effective-did';
import ServiceEmbed from '../components/ServiceEmbed';
import { resolveNavAppsForIdentity } from '@/src/lib/kernel/app-nav';

/**
 * `/auth/[app]` embeds registry apps. Legacy kernel wallet/media URLs
 * redirect to their standalone pages; every other slug must resolve to an app enabled for this
 * identity on the `auth-submenu` placement, or the route 404s — covering
 * both an unknown slug and a disabled/not-enabled one the same way.
 */
interface PageProps {
  params: Promise<{ app: string }>;
}

export default async function AppPage({ params }: Readonly<PageProps>) {
  const { app } = await params;
  if (app === 'pay' || app === 'media') {
    redirect(`/${app}`);
  }
  const { effectiveDid } = await getEffectiveDid();
  if (!effectiveDid) {
    redirect('/auth/login');
  }

  const navApps = await resolveNavAppsForIdentity(effectiveDid);
  const match = navApps.find((navApp) => navApp.slug === app && navApp.placements.includes('auth-submenu'));
  if (!match) {
    notFound();
  }

  const baseUrl = registryAppPublicUrl(match);
  return <ServiceEmbed service={app} did={effectiveDid} baseUrl={baseUrl} />;
}
