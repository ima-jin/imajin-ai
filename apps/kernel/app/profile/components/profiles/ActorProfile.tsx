import { buildPublicUrl } from '@imajin/config';
import { isVerifiedTier } from '@imajin/auth';
import { ScopeHeader } from '../ScopeHeader';
import { ProfileStats } from '../ProfileStats';
import { ContactCard } from '../ContactCard';
import { ServiceLinks } from '../ServiceLinks';
import { UpcomingEvents } from '../UpcomingEvents';
import { MarketItems } from '../MarketItems';
import { formatMemberSince } from '../../lib/profile-utils';
import type { ProfileViewProps } from '../../lib/types';

export function ActorProfile({ profile, identity, viewer, counts, links }: ProfileViewProps) {
  const isSoftDID = !isVerifiedTier(identity.tier);

  return (
    <div className="max-w-lg mx-auto">
      <div className="bg-[#0a0a0a] border border-white/10 p-8 text-center">
        <ScopeHeader profile={profile} identity={identity} />

        <ProfileStats
          counts={counts}
          viewerDid={viewer.viewerDid}
          isSelf={viewer.isSelf}
          targetDid={profile.did}
          isFollowing={viewer.isFollowing}
        />

        {/* Bio */}
        {profile.bio && (
          <p className="text-primary mb-6">{profile.bio}</p>
        )}

        {/* Info note for invited members viewing their own profile */}
        {isSoftDID && viewer.isSelf && (
          <p className="mb-6 text-xs text-secondary border border-white/10 px-4 py-3">
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

        {/* Upcoming events */}
        {profile.featureToggles?.show_events && (
          <UpcomingEvents did={profile.did} eventsBaseUrl={buildPublicUrl('events')} viewerDid={viewer.viewerDid} />
        )}

        {/* Market items */}
        {profile.featureToggles?.show_market_items && (
          <MarketItems did={profile.did} handle={profile.handle} marketBaseUrl={buildPublicUrl('market')} />
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
