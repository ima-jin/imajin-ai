import { registryAppBaseUrl } from '@/src/lib/apps/public-url';
import { profileWidgetUrl } from '@/src/lib/apps/profile-widget';
import type { NavApp } from '@/src/lib/kernel/app-nav';
import type { ProfileData } from './types';

export function resolveRegistryAppUrl(apps: readonly NavApp[], slug: string): string | null {
  const app = apps.find((candidate) => candidate.slug === slug);
  return app ? registryAppBaseUrl(app) : null;
}

/** Profile membership is the owner's decision, never registration, featuring, or a viewer's grant. */
export function enabledProfileWidgets(apps: readonly NavApp[], enabledSlugs: readonly string[], profile: ProfileData): NavApp[] {
  const enabled = new Set(enabledSlugs);
  return apps.filter((app) => enabled.has(app.slug)
    && profileWidgetUrl(app.entryUrl, app.profileWidget, profile.did, profile.handle) !== null);
}

export interface ProfileTab {
  id: string;
  label: string;
  icon: string;
  memberOnly?: boolean;
}

export function buildCommunityTabs(enabledServices: readonly string[], widgets: readonly NavApp[]): ProfileTab[] {
  const tabs: ProfileTab[] = [{ id: 'overview', label: 'Overview', icon: '🏠' }];
  tabs.push(...widgets.map((app) => ({
    id: `app:${app.slug}`,
    label: app.profileWidget?.label ?? app.name,
    icon: app.profileWidget?.icon ?? app.icon ?? '↗',
  })));
  if (enabledServices.includes('chat')) tabs.push({ id: 'chat', label: 'Chat', icon: '💬', memberOnly: true });
  tabs.push({ id: 'members', label: 'Members', icon: '👥' });
  return tabs;
}
