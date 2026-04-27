import { Avatar } from './Avatar';
import { getScopeLabel } from '../lib/profile-utils';
import { isVerifiedTier } from '@imajin/auth';
import type { ProfileData, IdentityInfo } from '../lib/types';

interface ScopeHeaderProps {
  profile: ProfileData;
  identity: IdentityInfo;
}

export function ScopeHeader({ profile, identity }: ScopeHeaderProps) {
  const typeLabel = getScopeLabel(identity.scope, identity.subtype);
  const isSoftDID = !isVerifiedTier(identity.tier);

  return (
    <>
      {/* Avatar */}
      <div className="mb-4 flex justify-center">
        <Avatar avatar={profile.avatar} displayName={profile.displayName} size="lg" />
      </div>

      {/* Name & Handle */}
      <h1 className="text-2xl font-bold mb-1 text-primary font-mono">{profile.displayName}</h1>
      {profile.handle && (
        <p className="text-secondary mb-2">@{profile.handle}</p>
      )}

      {/* Type badge & Identity Tier */}
      <div className="flex gap-2 justify-center mb-4 flex-wrap">
        <span className="inline-block px-3 py-1 bg-surface-surface border border-white/10 text-sm text-primary">
          {typeLabel}
        </span>
        {isSoftDID && (
          <span className="inline-block px-3 py-1 bg-warning/20 border border-warning/50 text-sm text-warning">
            ⚡ Quick Profile
          </span>
        )}
        {identity.chainVerified && (
          <span className="inline-block px-3 py-1 bg-emerald-900/30 border border-emerald-700/50 text-sm text-emerald-400">
            ⛓ Chain Verified
          </span>
        )}
        {identity.scope === 'business' && profile.claimStatus === 'unclaimed' && (
          <span className="inline-block px-3 py-1 bg-sky-900/30 border border-sky-700/50 text-sm text-sky-400">
            🤝 Community-maintained
          </span>
        )}
      </div>
    </>
  );
}
