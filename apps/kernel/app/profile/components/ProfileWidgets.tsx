import type { NavApp } from '@/src/lib/kernel/app-nav';
import { profileWidgetUrl } from '@/src/lib/apps/profile-widget';
import { registryAppBaseUrl } from '@/src/lib/apps/public-url';
import type { ProfileData } from '../lib/types';
import { enabledProfileWidgets } from '../lib/registry-app-links';
import { UpcomingEvents } from './UpcomingEvents';
import { MarketItems } from './MarketItems';

export function ProfileWidget({ app, profile, viewerDid }: Readonly<{ app: NavApp; profile: ProfileData; viewerDid: string | null }>) {
  const href = profileWidgetUrl(app.entryUrl, app.profileWidget, profile.did, profile.handle);
  if (!href) return null;
  const base = registryAppBaseUrl(app);
  if (app.slug === 'events' && base) return <UpcomingEvents did={profile.did} eventsBaseUrl={base} viewerDid={viewerDid} />;
  if (app.slug === 'market' && base) return <MarketItems did={profile.did} handle={profile.handle} marketBaseUrl={base} />;
  return (
    <section className="mb-6 rounded-lg border border-gray-800 p-4" data-profile-widget={app.slug}>
      <a href={href} target="_blank" rel="noopener noreferrer" className="text-orange-400 hover:underline">
        {app.profileWidget?.icon ?? app.icon} {app.profileWidget?.label}
      </a>
      <p className="text-xs text-gray-500 mt-1">{app.name}</p>
    </section>
  );
}

export function ProfileWidgets({ apps, enabledSlugs, profile, viewerDid }: Readonly<{
  apps: readonly NavApp[];
  enabledSlugs: readonly string[];
  profile: ProfileData;
  viewerDid: string | null;
}>) {
  return <>{enabledProfileWidgets(apps, enabledSlugs, profile).map((app) => (
    <ProfileWidget key={app.slug} app={app} profile={profile} viewerDid={viewerDid} />
  ))}</>;
}
