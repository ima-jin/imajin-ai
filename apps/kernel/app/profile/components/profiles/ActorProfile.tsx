import { ScopeHeader } from '../ScopeHeader';
import { ProfileStats } from '../ProfileStats';
import { ContactCard } from '../ContactCard';
import { ServiceLinks } from '../ServiceLinks';
import { UpcomingEvents } from '../UpcomingEvents';
import { MarketItems } from '../MarketItems';
import { formatMemberSince } from '../../lib/profile-utils';
import type { ProfileViewProps } from '../../lib/types';

export function ActorProfile({ profile, identity, viewer, counts, links, maintainerInfo }: ProfileViewProps) {
  const isSoftDID = identity.tier === 'soft';
  const servicePrefix = process.env.NEXT_PUBLIC_SERVICE_PREFIX || 'https://';
  const domain = process.env.NEXT_PUBLIC_DOMAIN || 'imajin.ai';

  return (
    <div className="max-w-lg mx-auto">
      <div className="bg-[#0a0a0a] border border-gray-800 rounded-2xl p-8 text-center">
        <ScopeHeader profile={profile} identity={identity} />

        {/* Unclaimed stub — maintainer info + join CTA */}
        {identity.scope === 'business' && profile.claimStatus === 'unclaimed' && maintainerInfo && (
          <div className="mb-4 bg-sky-950/30 border border-sky-800/40 rounded-xl px-4 py-3 text-sm text-sky-300">
            <p className="mb-1">
              This place is community-maintained.{' '}
              <span className="text-sky-400 font-medium">{maintainerInfo.count} maintainer{maintainerInfo.count !== 1 ? 's' : ''}</span> keeping it up to date.
            </p>
            {viewer.viewerDid && !maintainerInfo.isMaintainer && (
              <form action={`/profile/api/stubs/${encodeURIComponent(profile.did)}/join`} method="POST">
                <button
                  type="submit"
                  className="mt-2 px-4 py-1.5 bg-sky-700 hover:bg-sky-600 text-white rounded-lg text-xs font-medium transition-colors"
                >
                  Help maintain this place
                </button>
              </form>
            )}
            {viewer.viewerDid && maintainerInfo.isMaintainer && (
              <p className="mt-1 text-xs text-sky-500">You are a maintainer of this place.</p>
            )}
          </div>
        )}

        <ProfileStats
          counts={counts}
          viewerDid={viewer.viewerDid}
          isSelf={viewer.isSelf}
          targetDid={profile.did}
          isFollowing={viewer.isFollowing}
        />

        {/* Bio */}
        {profile.bio && (
          <p className="text-gray-300 mb-6">{profile.bio}</p>
        )}

        {/* Info note for invited members viewing their own profile */}
        {isSoftDID && viewer.isSelf && (
          <p className="mb-6 text-xs text-gray-500 border border-gray-800 rounded-lg px-4 py-3">
            Invited members can claim a handle and download backup keys
          </p>
        )}

        <ContactCard contactEmail={profile.contactEmail} phone={profile.phone} />

        <ServiceLinks profile={profile} viewerDid={viewer.viewerDid} />

        {/* Expanded links list */}
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

        {/* Upcoming events */}
        {profile.featureToggles?.show_events && (
          <UpcomingEvents did={profile.did} servicePrefix={servicePrefix} domain={domain} viewerDid={viewer.viewerDid} />
        )}

        {/* Market items */}
        {profile.featureToggles?.show_market_items && (
          <MarketItems did={profile.did} handle={profile.handle} servicePrefix={servicePrefix} domain={domain} />
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
