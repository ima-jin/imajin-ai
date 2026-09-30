import { redirect, notFound } from 'next/navigation';
import { buildPublicUrl } from '@imajin/config';
import { getEffectiveDid } from '../lib/get-effective-did';
import ServiceEmbed from '../components/ServiceEmbed';
import { isKernelNativeService } from '../lib/service-registry';
import { resolveNavAppsForIdentity } from '@/src/lib/kernel/app-nav';

/**
 * `/auth/[app]` (#2425) — one dynamic route replacing the 8 static
 * `/auth/{events,market,coffee,dykil,learn,links,pay,media}/page.tsx`
 * files. Kernel-native services (pay/media, never pruned) embed directly;
 * every other slug must resolve to a registry app enabled for this
 * identity on the `auth-submenu` placement, or the route 404s — covering
 * both an unknown slug and a disabled/not-enabled one the same way.
 */
interface PageProps {
  params: Promise<{ app: string }>;
}

export default async function AppPage({ params }: Readonly<PageProps>) {
  const { app } = await params;
  const { effectiveDid } = await getEffectiveDid();
  if (!effectiveDid) {
    redirect('/auth/login');
  }

  if (isKernelNativeService(app)) {
    return <ServiceEmbed service={app} did={effectiveDid} />;
  }

  const navApps = await resolveNavAppsForIdentity(effectiveDid);
  const match = navApps.find((navApp) => navApp.slug === app && navApp.placements.includes('auth-submenu'));
  if (!match) {
    notFound();
  }

  // #2425 send-back: resolve the embed origin FROM THE REGISTRY ROW'S OWN
  // SLUG via buildPublicUrl (the same env-aware, NEXT_PUBLIC_<SLUG>_URL +
  // subdomain/path-fallback mechanism every other kernel surface already
  // uses for a service's public URL) instead of ServiceEmbed silently
  // falling back to service-registry.ts's static, 6-name-only map. A newly
  // provisioned third-party app that exists only as a registry row (no
  // hand-added SERVICE_URLS entry) now gets a working embed too.
  const baseUrl = buildPublicUrl(match.slug);
  return <ServiceEmbed service={app} did={effectiveDid} baseUrl={baseUrl} />;
}
