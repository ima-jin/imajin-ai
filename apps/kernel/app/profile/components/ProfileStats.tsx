import { FollowButton } from './FollowButton';
import type { ProfileCounts } from '../lib/types';

interface ProfileStatsProps {
  counts: ProfileCounts;
  viewerDid: string | null;
  isSelf: boolean;
  targetDid: string;
  isFollowing: boolean;
}

export function ProfileStats({ counts, viewerDid, isSelf, targetDid, isFollowing }: ProfileStatsProps) {
  return (
    <div className="mb-6 flex flex-col items-center gap-3">
      <p className="text-sm text-gray-400">
        <span className="text-white font-medium">{counts.followers}</span> followers
        {' · '}
        <span className="text-white font-medium">{counts.following}</span> following
        {' · '}
        <span className="text-white font-medium">{counts.connections}</span> connections
      </p>
      {viewerDid && !isSelf && (
        <FollowButton targetDid={targetDid} initialFollowing={isFollowing} />
      )}
    </div>
  );
}
