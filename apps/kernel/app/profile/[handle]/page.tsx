import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import {
  getViewerDid,
  getProfile,
  getProfileCounts,
  getFollowStatus,
  isConnected,
  getLinks,
  getIdentityInfo,
} from '../lib/profile-data';
import { getScopeEmoji } from '../lib/profile-utils';
import { GatedProfile } from '../components/GatedProfile';
import { ActorProfile } from '../components/profiles/ActorProfile';
import { BusinessProfile } from '../components/profiles/BusinessProfile';
import { CommunityProfile } from '../components/profiles/CommunityProfile';
import { FamilyProfile } from '../components/profiles/FamilyProfile';

interface PageProps {
  params: Promise<{ handle: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { handle } = await params;
  const profile = await getProfile(handle);

  if (!profile) {
    return { title: 'Profile Not Found' };
  }

  const identity = await getIdentityInfo(profile.did);
  const emoji = getScopeEmoji(identity.scope, identity.subtype);
  const displayHandle = profile.handle ? `@${profile.handle}` : handle;
  const description = profile.bio
    ? profile.bio.slice(0, 200) + (profile.bio.length > 200 ? '...' : '')
    : `${emoji} ${identity.subtype ?? identity.scope} on the Imajin network`;

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'https://profile.imajin.ai';
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
      images: profile.avatar?.startsWith('http') ? [{ url: profile.avatar }] : undefined,
    },
    twitter: {
      card: profile.avatar?.startsWith('http') ? 'summary_large_image' : 'summary',
      title: `${profile.displayName} ${emoji}`,
      description,
      images: profile.avatar?.startsWith('http') ? [profile.avatar] : undefined,
    },
  };
}

export default async function ProfilePage({ params }: PageProps) {
  const { handle } = await params;
  const profile = await getProfile(handle);

  if (!profile) {
    notFound();
  }

  const viewerDid = await getViewerDid();
  const isSelf = viewerDid === profile.did;
  const connected = viewerDid && !isSelf ? await isConnected(viewerDid, profile.did) : false;

  if (!isSelf && !connected) {
    return <GatedProfile profile={profile} viewerDid={viewerDid} />;
  }

  const [identity, counts, isFollowing, links] = await Promise.all([
    getIdentityInfo(profile.did),
    getProfileCounts(profile.did),
    viewerDid && !isSelf ? getFollowStatus(viewerDid, profile.did) : Promise.resolve(false),
    profile.featureToggles?.links ? getLinks(profile.featureToggles.links) : Promise.resolve([]),
  ]);

  const viewer = {
    viewerDid,
    isSelf,
    isConnected: !!connected,
    isFollowing: isFollowing as boolean,
  };

  const props = { profile, identity, viewer, counts, links };

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
