import { getMembersByRole } from '../../lib/profile-data';
import { formatMemberSince } from '../../lib/profile-utils';
import { ScopeHeader } from '../ScopeHeader';
import { MemberList } from '../MemberList';
import type { ProfileViewProps } from '../../lib/types';

export async function FamilyProfile({ profile, identity, viewer }: ProfileViewProps) {
  const members = await getMembersByRole(profile.did);
  const isMember = viewer.viewerDid
    ? members.some((m) => m.did === viewer.viewerDid)
    : false;

  return (
    <div className="max-w-lg mx-auto">
      <div className="bg-[#0a0a0a] border border-white/10 p-8 text-center">
        <ScopeHeader profile={profile} identity={identity} />

        {isMember || viewer.isSelf ? (
          <>
            {/* Bio */}
            {profile.bio && (
              <p className="text-primary mb-6">{profile.bio}</p>
            )}

            {/* Member list (flat, no role grouping) */}
            <MemberList
              identityDid={profile.did}
              showCount
              title="Members"
            />
          </>
        ) : (
          /* Non-member locked view */
          <div className="mb-6 bg-surface-surface/50 border border-white/10 p-6">
            <p className="text-2xl mb-2">🔒</p>
            <p className="text-primary font-medium mb-1">Private family group</p>
            <p className="text-sm text-secondary">
              {members.length} {members.length === 1 ? 'member' : 'members'}
            </p>
          </div>
        )}

        {/* Member since */}
        <p className="text-xs text-secondary mt-4">
          Member since {formatMemberSince(profile.createdAt)}
        </p>
      </div>

      {/* DID */}
      <p className="text-center text-xs text-secondary mt-4 font-mono break-all">
        {profile.did}
      </p>
    </div>
  );
}
