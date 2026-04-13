import { getMaintainerInfo } from '../../lib/profile-data';
import { formatMemberSince } from '../../lib/profile-utils';
import { ScopeHeader } from '../ScopeHeader';
import { ServiceLinks } from '../ServiceLinks';
import { BusinessDetails } from '../BusinessDetails';
import { MemberList } from '../MemberList';
import { StubActions } from '../StubActions';
import type { ProfileViewProps } from '../../lib/types';

export async function BusinessProfile({ profile, identity, viewer, counts, links }: ProfileViewProps) {
  const maintainerInfo = await getMaintainerInfo(profile.did, viewer.viewerDid);
  const isUnclaimed = !profile.claimStatus || profile.claimStatus === 'unclaimed';

  // For unclaimed stubs: show maintainers. For claimed: show owners/admins.
  const memberRoleFilter = isUnclaimed ? 'maintainer' : 'owner';
  const memberTitle = isUnclaimed ? '🔧 Maintainers' : '👑 Owners & Admins';

  return (
    <div className="max-w-lg mx-auto">
      <div className="bg-[#0a0a0a] border border-gray-800 rounded-2xl p-8 text-center">
        <ScopeHeader profile={profile} identity={identity} />

        {/* Bio / about */}
        {profile.bio && (
          <p className="text-gray-300 mb-6">{profile.bio}</p>
        )}

        {/* Business metadata */}
        <BusinessDetails metadata={profile.metadata} />

        {/* Members */}
        {isUnclaimed ? (
          <MemberList
            identityDid={profile.did}
            roleFilter="maintainer"
            showCount
            title={memberTitle}
          />
        ) : (
          <MemberList
            identityDid={profile.did}
            grouped
            showCount
            title={memberTitle}
          />
        )}

        {/* Stub / maintainer actions */}
        {(isUnclaimed || maintainerInfo.isMaintainer) && (
          <StubActions
            identityDid={profile.did}
            profileHandle={profile.handle}
            claimStatus={profile.claimStatus}
            isMaintainer={maintainerInfo.isMaintainer}
            viewerDid={viewer.viewerDid}
          />
        )}

        <ServiceLinks profile={profile} viewerDid={viewer.viewerDid} />

        {/* Expanded links */}
        {links.length > 0 && (
          <div className="mb-6 space-y-2">
            {links.map((link, i) => (
              <a
                key={i}
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                className="block px-4 py-3 bg-gray-900 border border-gray-800 rounded-lg hover:bg-gray-800 transition text-left"
              >
                <p className="text-white text-sm font-medium">{link.title}</p>
                {link.description && (
                  <p className="text-gray-500 text-xs mt-0.5">{link.description}</p>
                )}
              </a>
            ))}
          </div>
        )}

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
