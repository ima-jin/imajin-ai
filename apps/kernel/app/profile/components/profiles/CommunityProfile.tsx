import { buildPublicUrl } from '@imajin/config';
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
import { MemberSection } from '../MemberSection';
import type { ProfileViewProps } from '../../lib/types';

export async function CommunityProfile({
  profile,
  identity,
  viewer,
  links,
}: ProfileViewProps) {
  const [forestConfig, viewerMemberRole] = await Promise.all([
    getForestConfig(profile.did),
    viewer.viewerDid && !viewer.isSelf
      ? getViewerMembership(profile.did, viewer.viewerDid)
      : Promise.resolve(viewer.isSelf ? 'owner' : null),
  ]);

  const isMaintainer =
    viewerMemberRole === 'owner' ||
    viewerMemberRole === 'admin' ||
    viewerMemberRole === 'maintainer';

  const allMembers = await getMembersByRole(profile.did);
  const memberCount = allMembers.length;

  const topMembers = allMembers
    .filter((m) => ['owner', 'admin', 'maintainer'].includes(m.role))
    .slice(0, 5);

  const showEvents =
    forestConfig?.enabledServices.includes('events') &&
    profile.featureToggles?.show_events;

  const showMarket =
    forestConfig?.enabledServices.includes('market') &&
    profile.featureToggles?.show_market_items;

  return (
    <div className="max-w-lg mx-auto">
      <div className="bg-[#0a0a0a] border border-gray-800 rounded-2xl overflow-hidden">
        {/* 1. Banner */}
        {profile.banner && (
          <div
            className="w-full h-48 bg-cover bg-center"
            style={{ backgroundImage: `url(${profile.banner})` }}
          />
        )}

        <div className="p-8 text-center">
          {/* 2. Header */}
          <ScopeHeader profile={profile} identity={identity} />

          {profile.bio && (
            <p className="text-gray-300 mb-6">{profile.bio}</p>
          )}

          {/* 3. Action row */}
          <div className="flex items-center justify-center gap-3">
            <JoinButton
              identityDid={profile.did}
              viewerDid={viewer.viewerDid}
              initialMemberRole={viewerMemberRole}
            />
            {viewer.viewerDid && !viewer.isSelf && (
              <FollowButton
                targetDid={profile.did}
                initialFollowing={viewer.isFollowing}
              />
            )}
          </div>

          {/* 4. Member summary */}
          {memberCount > 0 && (
            <div className="flex items-center justify-center gap-3 mb-6">
              <span className="text-sm text-gray-400">
                {memberCount} member{memberCount !== 1 ? 's' : ''}
              </span>
              {topMembers.length > 0 && (
                <div className="flex items-center -space-x-2">
                  {topMembers.map((m) => (
                    <a
                      key={m.did}
                      href={`/profile/${m.handle ?? m.did}`}
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

          {/* 5. Upcoming events */}
          {showEvents && (
            <UpcomingEvents
              did={profile.did}
              eventsBaseUrl={buildPublicUrl('events')}
              viewerDid={viewer.viewerDid}
            />
          )}

          {/* 6. Market items */}
          {showMarket && (
            <MarketItems
              did={profile.did}
              handle={profile.handle}
              marketBaseUrl={buildPublicUrl('market')}
            />
          )}

          {/* 7. Gallery */}
          <StubGallery identityDid={profile.did} isMaintainer={isMaintainer} />

          {/* 8. Links */}
          {links.length > 0 && (
            <div className="mb-6 space-y-2 text-left">
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

          {/* 9. Members section */}
          {memberCount > 0 && (
            <MemberSection memberCount={memberCount} topMembers={topMembers}>
              <MemberList
                identityDid={profile.did}
                grouped
                showCount
                title="Members"
              />
            </MemberSection>
          )}

          {/* 10. Contact */}
          <ContactCard contactEmail={profile.contactEmail} phone={profile.phone} />

          {/* Member since */}
          <p className="text-xs text-gray-500 mt-4">
            Member since {formatMemberSince(profile.createdAt)}
          </p>
        </div>
      </div>

      {/* 11. Footer */}
      <div className="text-center mt-4 space-y-1">
        <p className="text-xs text-gray-600">Powered by Imajin</p>
        <CopyDid did={profile.did} />
      </div>
    </div>
  );
}
