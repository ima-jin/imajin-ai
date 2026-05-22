import { buildPublicUrl, profilePath } from '@imajin/config';
import { getForestConfig, getViewerMembership, getMembersByRole } from '../../lib/profile-data';
import { formatMemberSince } from '../../lib/profile-utils';
import { ScopeHeader } from '../ScopeHeader';
import { JoinButton } from '../JoinButton';
import { FollowButton } from '../FollowButton';
import { UpcomingEvents } from '../UpcomingEvents';
import { MarketItems } from '../MarketItems';
import { StubGallery } from '../StubGallery';
import { ContactCard } from '../ContactCard';
import { MemberList } from '../MemberList';
import { Avatar } from '../Avatar';
import { CopyDid } from '../CopyDid';

import { CommunityPageClient } from './CommunityPageClient';
import type { ProfileViewProps } from '../../lib/types';
import type { CommunityTab } from '../CommunityTabs';

async function resolveCanJoin(
  profileDid: string,
  viewer: Readonly<ProfileViewProps>['viewer'],
  viewerMemberRole: string | null,
  forestConfig: Awaited<ReturnType<typeof getForestConfig>>
): Promise<{ canJoin: boolean; joinVisibility: 'open' | 'network' | 'invite' }> {
  const joinVisibility = forestConfig?.joinVisibility ?? 'open';
  const joinNetworkDepth = forestConfig?.joinNetworkDepth ?? 2;

  if (viewerMemberRole) {
    return { canJoin: true, joinVisibility };
  }

  if (joinVisibility === 'invite') {
    return { canJoin: false, joinVisibility };
  }

  if (joinVisibility === 'network') {
    if (!viewer.viewerDid) {
      return { canJoin: false, joinVisibility };
    }
    const { isInMemberNetwork } = await import('../../lib/network-check');
    const inNetwork = await isInMemberNetwork(profileDid, viewer.viewerDid, joinNetworkDepth);
    return { canJoin: inNetwork, joinVisibility };
  }

  return { canJoin: true, joinVisibility };
}

export async function CommunityProfile({ profile, identity, viewer, links }: Readonly<ProfileViewProps>) {
  const [forestConfig, viewerMemberRole] = await Promise.all([
    getForestConfig(profile.did),
    viewer.viewerDid && !viewer.isSelf
      ? getViewerMembership(profile.did, viewer.viewerDid)
      : Promise.resolve(viewer.isSelf ? 'owner' : null),
  ]);

  const { canJoin, joinVisibility } = await resolveCanJoin(
    profile.did, viewer, viewerMemberRole, forestConfig
  );

  const isMember = !!viewerMemberRole;
  const isMaintainer = ['owner', 'admin', 'maintainer'].includes(viewerMemberRole ?? '');

  const allMembers = await getMembersByRole(profile.did);
  const memberCount = allMembers.length;
  const topMembers = allMembers
    .filter(m => ['owner', 'admin', 'maintainer'].includes(m.role))
    .slice(0, 5);

  const enabledServices = forestConfig?.enabledServices ?? [];

  // Determine which tabs to show
  const enabledTabs: CommunityTab[] = ['overview'];
  if (enabledServices.includes('events') || profile.featureToggles?.show_events) {
    enabledTabs.push('events');
  }
  if (enabledServices.includes('chat')) {
    enabledTabs.push('chat');
  }
  enabledTabs.push('members'); // always show members
  if (enabledServices.includes('market') && profile.featureToggles?.show_market_items) {
    enabledTabs.push('market');
  }

  const showEvents = enabledServices.includes('events') && profile.featureToggles?.show_events;
  const showMarket = enabledServices.includes('market') && profile.featureToggles?.show_market_items;

  // --- Build tab content sections ---

  const overviewContent = (
    <div className="space-y-6">
      {/* Gallery */}
      <StubGallery identityDid={profile.did} isMaintainer={isMaintainer} />

      {/* Links */}
      {links.length > 0 && (
        <div className="space-y-2">
          {links.map((link, i) => (
            <a
              key={i}
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              className="block px-4 py-3 bg-gray-900 border border-gray-800 rounded-lg hover:bg-gray-800 transition"
            >
              <p className="text-white text-sm font-medium">{link.title}</p>
              {link.description && (
                <p className="text-gray-500 text-xs mt-0.5">{link.description}</p>
              )}
            </a>
          ))}
        </div>
      )}

      {/* Contact */}
      <ContactCard contactEmail={profile.contactEmail} phone={profile.phone} />

      <p className="text-xs text-gray-500 text-center">
        Member since {formatMemberSince(profile.createdAt)}
      </p>
    </div>
  );

  const eventsContent = showEvents ? (
    <UpcomingEvents
      did={profile.did}
      eventsBaseUrl={buildPublicUrl('events')}
      viewerDid={viewer.viewerDid}
    />
  ) : (
    <p className="text-sm text-zinc-500 text-center py-8">No events yet</p>
  );

  const membersContent = (
    <MemberList
      identityDid={profile.did}
      grouped
      showCount
      title="Members"
    />
  );

  const marketContent = showMarket ? (
    <MarketItems
      did={profile.did}
      handle={profile.handle}
      marketBaseUrl={buildPublicUrl('market')}
    />
  ) : null;

  return (
    <div className="max-w-2xl mx-auto">
      <div className="bg-[#0a0a0a] border border-gray-800 rounded-2xl overflow-hidden">
        {/* Banner */}
        {profile.banner && (
          <div
            className="w-full h-48 bg-cover bg-center"
            style={{ backgroundImage: `url(${profile.banner})` }}
          />
        )}

        <div className="p-8">
          {/* Header — always visible */}
          <div className="text-center mb-6">
            <ScopeHeader profile={profile} identity={identity} />

            {profile.bio && (
              <p className="text-gray-300 mb-4">{profile.bio}</p>
            )}

            {/* Actions */}
            <div className="flex items-center justify-center gap-3 mb-4">
              <JoinButton
                identityDid={profile.did}
                viewerDid={viewer.viewerDid}
                initialMemberRole={viewerMemberRole}
                canJoin={canJoin}
                joinVisibility={joinVisibility}
              />
              {viewer.viewerDid && !viewer.isSelf && (
                <FollowButton
                  targetDid={profile.did}
                  initialFollowing={viewer.isFollowing}
                />
              )}
            </div>

            {/* Member count + avatars */}
            {memberCount > 0 && (
              <div className="flex items-center justify-center gap-3 mb-2">
                <span className="text-sm text-gray-400">
                  {memberCount} member{memberCount !== 1 ? 's' : ''}
                </span>
                {topMembers.length > 0 && (
                  <div className="flex items-center -space-x-2">
                    {topMembers.map(m => (
                      <a
                        key={m.did}
                        href={profilePath(m.handle ?? m.did)}
                        title={m.displayName}
                        className="relative inline-block border-2 border-[#0a0a0a] rounded-full"
                      >
                        <Avatar avatar={m.avatar} displayName={m.displayName} size="sm" />
                      </a>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Tabbed content */}
          <CommunityPageClient
            enabledTabs={enabledTabs}
            isMember={isMember}
            overviewContent={overviewContent}
            eventsContent={eventsContent}
            membersContent={membersContent}
            marketContent={marketContent}
            communityDid={profile.did}
          />
        </div>
      </div>

      {/* Footer */}
      <div className="text-center mt-4 space-y-1">
        <p className="text-xs text-gray-600">Powered by Imajin</p>
        <CopyDid did={profile.did} />
      </div>
    </div>
  );
}
