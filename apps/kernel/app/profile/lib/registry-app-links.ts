/**
 * Registry-derived app links for the profile views (#2434).
 *
 * `ActorProfile` / `CommunityProfile` used to hard-code
 * `buildPublicUrl('events')` / `buildPublicUrl('market')` and render the
 * events/market widgets unconditionally on a profile toggle. That goes stale
 * the moment those apps are pruned (#1988/#1989): the widget would keep
 * pointing at an app that no longer exists. These helpers make the registry
 * (`registry.apps`, via `resolveRegistryAppsBySlug`) the authority — an app
 * is linkable only while it has an active registry row, and its URL comes
 * from its own entryUrl (with an explicit env override for local servers),
 * never a historical static port hint.
 */
import { registryAppBaseUrl } from '@/src/lib/apps/public-url';
import type { NavApp } from '@/src/lib/kernel/app-nav';
import type { FeatureToggles } from './types';
import type { CommunityTab } from '../components/CommunityTabs';

/** Slugs of the registry apps the profile widgets can link to. */
export const PROFILE_WIDGET_APP_SLUGS = ['events', 'market'] as const;

/** App API base, or null when absent or only an arbitrary entry destination is known. */
export function resolveRegistryAppUrl(apps: readonly NavApp[], slug: string): string | null {
  const app = apps.find((app) => app.slug === slug);
  return app ? registryAppBaseUrl(app) : null;
}

export interface CommunityTabInputs {
  enabledServices: readonly string[];
  featureToggles: FeatureToggles | undefined;
  eventsUrl: string | null;
  marketUrl: string | null;
}

/**
 * Tabs a community profile shows. Events/market tabs additionally require
 * their app to still exist in the registry (a pruned app drops the tab
 * instead of leaving a dead one). `overview` and `members` are always shown.
 */
export function buildCommunityTabs(inputs: Readonly<CommunityTabInputs>): CommunityTab[] {
  const { enabledServices, featureToggles, eventsUrl, marketUrl } = inputs;
  const tabs: CommunityTab[] = ['overview'];

  const eventsOn = enabledServices.includes('events') || Boolean(featureToggles?.show_events);
  if (eventsUrl && eventsOn) tabs.push('events');

  if (enabledServices.includes('chat')) tabs.push('chat');
  tabs.push('members');

  const marketOn = enabledServices.includes('market') && Boolean(featureToggles?.show_market_items);
  if (marketUrl && marketOn) tabs.push('market');

  return tabs;
}
