import { getMembersByRole, getViewerMembership } from '../../lib/profile-data';
import { formatMemberSince } from '../../lib/profile-utils';
import { ScopeHeader } from '../ScopeHeader';
import { ServiceLinks } from '../ServiceLinks';
import { BusinessDetails } from '../BusinessDetails';
import { MemberList } from '../MemberList';
import { StubActions } from '../StubActions';
import { StubGallery } from '../StubGallery';
import type { ProfileViewProps } from '../../lib/types';

export async function BusinessProfile({ profile, identity, viewer, counts, links }: ProfileViewProps) {
  const isUnclaimed = !profile.claimStatus || profile.claimStatus === 'unclaimed';
  const viewerRole = viewer.viewerDid && !viewer.isSelf
    ? await getViewerMembership(profile.did, viewer.viewerDid)
    : viewer.isSelf ? 'owner' : null;
  const isMaintainer = viewerRole === 'maintainer' || viewerRole === 'owner' || viewerRole === 'admin';

  // For unclaimed stubs: show maintainers. For claimed: show owners/admins.
  const memberRoleFilter = isUnclaimed ? 'maintainer' : 'owner';
  const memberTitle = isUnclaimed ? '🔧 Maintainers' : '👑 Owners & Admins';

  return (
    <div className="max-w-lg mx-auto">
      <div className="bg-[#0a0a0a] border border-white/10 overflow-hidden text-center">
        {/* Banner */}
        {profile.banner && (
          <div
            className="w-full h-48 bg-cover bg-center"
            style={{ backgroundImage: `url(${profile.banner})` }}
          />
        )}

        <div className="p-8">
        <ScopeHeader profile={profile} identity={identity} />

        {/* Bio / about */}
        {profile.bio && (
          <p className="text-primary mb-6">{profile.bio}</p>
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
        {(isUnclaimed || isMaintainer) && (
          <StubActions
            identityDid={profile.did}
            profileHandle={profile.handle}
            claimStatus={profile.claimStatus}
            isMaintainer={isMaintainer}
            viewerDid={viewer.viewerDid}
          />
        )}

        {/* Gallery */}
        <StubGallery identityDid={profile.did} isMaintainer={isMaintainer} />

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
                className="block px-4 py-3 bg-surface-surface border border-white/10 hover:bg-surface-elevated transition text-left"
              >
                <p className="text-primary text-sm font-medium">{link.title}</p>
                {link.description && (
                  <p className="text-secondary text-xs mt-0.5">{link.description}</p>
                )}
              </a>
            ))}
          </div>
        )}

        {/* Member since */}
        <p className="text-xs text-secondary mt-4">
          Member since {formatMemberSince(profile.createdAt)}
        </p>
        </div>
      </div>

      {/* DID */}
      <p className="text-center text-xs text-secondary mt-4 font-mono break-all">
        {profile.did}
      </p>
    </div>
  );
}
