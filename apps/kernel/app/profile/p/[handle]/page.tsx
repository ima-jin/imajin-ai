import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { buildPublicUrlAbsolute } from '@imajin/config';
import { resolveEnabledApps } from '@/src/lib/profile/feature-toggles-compat';
import { resolveRegistryAppsBySlug } from '@/src/lib/kernel/app-nav';
import { PROFILE_WIDGET_APP_SLUGS } from '../../lib/registry-app-links';
import {
  getViewerDid,
  getProfile,
  getProfileCounts,
  getFollowStatus,
  isConnected,
  getLinks,
  getIdentityInfo,
} from '../../lib/profile-data';
import { getScopeEmoji } from '../../lib/profile-utils';
import { GatedProfile } from '../../components/GatedProfile';
import { ActorProfile } from '../../components/profiles/ActorProfile';
import { BusinessProfile } from '../../components/profiles/BusinessProfile';
import { CommunityProfile } from '../../components/profiles/CommunityProfile';
import { FamilyProfile } from '../../components/profiles/FamilyProfile';

interface PageProps {
  params: Promise<{ handle: string }>;
}

export async function generateMetadata({ params }: Readonly<PageProps>): Promise<Metadata> {
  const { handle } = await params;
  const profile = await getProfile(handle);

  if (!profile) {
    return { title: 'Profile Not Found' };
  }

  const identity = await getIdentityInfo(profile.did);
  const emoji = getScopeEmoji(identity.scope, identity.subtype);
  const displayHandle = profile.handle ? `@${profile.handle}` : handle;
  const bioTruncationSuffix = profile.bio && profile.bio.length > 200 ? '...' : '';
  const description = profile.bio
    ? profile.bio.slice(0, 200) + bioTruncationSuffix
    : `${emoji} ${identity.subtype ?? identity.scope} on the Imajin network`;

  const baseUrl = buildPublicUrlAbsolute('profile');
  const url = `${baseUrl}/${handle}`;

  return {
    title: `${profile.displayName} (${displayHandle})`,
    description,
    openGraph: {
      title: `${profile.displayName} ${emoji}`,
      description,
      url,
      siteName: 'Imajin Profiles',
      type: 'profile',
      images: (() => {
        if (profile.avatar?.startsWith('http')) return [{ url: profile.avatar }];
        if (profile.avatar?.startsWith('/')) return [{ url: `${baseUrl}${profile.avatar}` }];
        return undefined;
      })(),
    },
    twitter: {
      card: profile.avatar ? 'summary_large_image' : 'summary',
      title: `${profile.displayName} ${emoji}`,
      description,
      images: (() => {
        if (profile.avatar?.startsWith('http')) return [profile.avatar];
        if (profile.avatar?.startsWith('/')) return [`${baseUrl}${profile.avatar}`];
        return undefined;
      })(),
    },
  };
}

export default async function ProfilePage({ params }: Readonly<PageProps>) {
  const { handle } = await params;
  const profile = await getProfile(handle);

  if (!profile) {
    notFound();
  }

  const viewerDid = await getViewerDid();
  const isSelf = viewerDid === profile.did;
  const identity = await getIdentityInfo(profile.did);
  const connected = viewerDid && !isSelf ? await isConnected(viewerDid, profile.did) : false;

  // Business/community profiles are publicly visible; actor/family require connection
  const isPublicScope = identity.scope === 'business' || identity.scope === 'community';
  if (!isSelf && !connected && !isPublicScope) {
    return <GatedProfile profile={profile} viewerDid={viewerDid} />;
  }

  // #2434: every "is app X on for this profile" question goes through
  // resolveEnabledApps (legacy fields ∪ enabledApps) — including `links`,
  // which used to read the legacy `featureToggles.links` field directly and
  // so ignored a profile that enabled links via `enabledApps` only.
  const enabledApps = resolveEnabledApps(profile.featureToggles);
  const linksHandle = enabledApps.includes('links')
    ? (profile.featureToggles?.links || profile.handle)
    : null;

  const [counts, isFollowing, links, registryApps] = await Promise.all([
    getProfileCounts(profile.did),
    viewerDid && !isSelf ? getFollowStatus(viewerDid, profile.did) : Promise.resolve(false),
    // The links service is keyed by the profile's handle — the value the legacy
    // field always carried (see `profile/edit/page.tsx`'s write path); fall back
    // to the current handle for a profile that enabled links via `enabledApps` only.
    linksHandle ? getLinks(linksHandle) : Promise.resolve([]),
    // One registry read covers both the owner-enabled service buttons
    // (#2425 send-back: registry apps ∩ resolveEnabledApps — replaces
    // ServiceLinks.tsx's own hard-coded 'links'/'coffee' literals) and the
    // events/market widget apps (#2434). Public, unauthenticated read (the
    // profile owner already opted in via feature_toggles); see
    // resolveRegistryAppsBySlug's docblock.
    resolveRegistryAppsBySlug([...enabledApps, ...PROFILE_WIDGET_APP_SLUGS]),
  ]);
  const enabledAppSet = new Set(enabledApps);
  const serviceApps = registryApps.filter((app) => enabledAppSet.has(app.slug));

  const viewer = {
    viewerDid,
    isSelf,
    isConnected: !!connected,
    isFollowing,
  };

  const props = { profile, identity, viewer, counts, links, serviceApps, registryApps };

  switch (identity.scope) {
    case 'business':
      return <BusinessProfile {...props} />;
    case 'community':
      return <CommunityProfile {...props} />;
    case 'family':
      return <FamilyProfile {...props} />;
    case 'actor':
    default:
      return <ActorProfile {...props} />;
  }
}
