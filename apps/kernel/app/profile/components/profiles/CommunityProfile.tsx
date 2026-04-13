import { getForestConfig, getViewerMembership } from '../../lib/profile-data';
import { formatMemberSince } from '../../lib/profile-utils';
import { ScopeHeader } from '../ScopeHeader';
import { MemberList } from '../MemberList';
import { ForestServices } from '../ForestServices';
import { JoinButton } from '../JoinButton';
import type { ProfileViewProps } from '../../lib/types';

export async function CommunityProfile({ profile, identity, viewer }: ProfileViewProps) {
  const [forestConfig, viewerMemberRole] = await Promise.all([
    getForestConfig(profile.did),
    viewer.viewerDid && !viewer.isSelf
      ? getViewerMembership(profile.did, viewer.viewerDid)
      : Promise.resolve(viewer.isSelf ? 'owner' : null),
  ]);

  return (
    <div className="max-w-lg mx-auto">
      <div className="bg-[#0a0a0a] border border-gray-800 rounded-2xl p-8 text-center">
        <ScopeHeader profile={profile} identity={identity} />

        {/* Purpose / about */}
        {profile.bio && (
          <p className="text-gray-300 mb-6">{profile.bio}</p>
        )}

        {/* Member list grouped by role */}
        <MemberList identityDid={profile.did} grouped showCount title="Members" />

        {/* Enabled services */}
        {forestConfig && forestConfig.enabledServices.length > 0 && (
          <ForestServices
            enabledServices={forestConfig.enabledServices}
            handle={profile.handle}
          />
        )}

        {/* Join button */}
        <JoinButton
          identityDid={profile.did}
          viewerDid={viewer.viewerDid}
          initialMemberRole={viewerMemberRole}
        />

        {/* Member since */}
        <p className="text-xs text-gray-500 mt-4">
          Member since {formatMemberSince(profile.createdAt)}
        </p>
      </div>

      {/* DID */}
      <p className="text-center text-xs text-gray-500 mt-4 font-mono break-all">
        {profile.did}
      </p>
    </div>
  );
}
