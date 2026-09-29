import type { NavApp } from '@/src/lib/kernel/app-nav';

export interface FeatureToggles {
  inference_enabled?: boolean;
  show_market_items?: boolean;
  show_events?: boolean;
  /** @deprecated (#2425) superseded by `enabledApps` — see `src/db/schemas/profile.ts`'s `FeatureToggles`. */
  links?: string | null;
  coffee?: string | null;
  dykil?: string | null;
  learn?: string | null;
  /** Generic, slug-keyed replacement for the per-app fields above (#2425). */
  enabledApps?: string[];
}

export interface ProfileData {
  did: string;
  handle?: string;
  displayName: string;
  bio?: string;
  avatar?: string;
  banner?: string;
  email?: string;
  phone?: string;
  contactEmail?: string;
  featureToggles?: FeatureToggles;
  createdAt: string;
  metadata?: Record<string, unknown>;
  claimStatus?: string | null;
}

export interface IdentityInfo {
  scope: 'actor' | 'business' | 'community' | 'family';
  subtype: string | null;
  tier: string;
  chainVerified: boolean;
}

export interface ViewerContext {
  viewerDid: string | null;
  isSelf: boolean;
  isConnected: boolean;
  isFollowing: boolean;
}

export interface ProfileCounts {
  followers: number;
  following: number;
  connections: number;
}

export interface LinkItem {
  title: string;
  url: string;
  description?: string;
}

export interface ProfileViewProps {
  profile: ProfileData;
  identity: IdentityInfo;
  viewer: ViewerContext;
  counts: ProfileCounts;
  links: LinkItem[];
  /** Registry apps (#2425) resolved for this profile's own enabled slugs — see `resolveRegistryAppsBySlug`. Consumed by `ServiceLinks`. */
  serviceApps: NavApp[];
}
