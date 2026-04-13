import { buildPublicUrl } from '@imajin/config';
import { Avatar } from './Avatar';
import type { ProfileData } from '../lib/types';

interface GatedProfileProps {
  profile: ProfileData;
  viewerDid: string | null;
}

export function GatedProfile({ profile, viewerDid }: GatedProfileProps) {
  return (
    <div className="max-w-lg mx-auto text-center py-16">
      <div className="bg-[#0a0a0a] border border-gray-800 rounded-2xl p-8">
        <div className="mb-4 flex justify-center">
          <Avatar avatar={profile.avatar} displayName={profile.displayName} size="lg" />
        </div>
        <h1 className="text-2xl font-bold mb-1 text-white">{profile.displayName}</h1>
        {profile.handle && <p className="text-gray-400 mb-4">@{profile.handle}</p>}
        <div className="py-6 border-t border-gray-800 mt-4">
          <p className="text-gray-500 text-sm">
            🔒 This profile is only visible to connections.
          </p>
          {!viewerDid && (
            <a
              href={`${buildPublicUrl('auth')}/login`}
              className="inline-block mt-4 px-6 py-2 bg-[#F59E0B] text-black rounded-lg hover:bg-[#D97706] transition font-medium text-sm"
            >
              Login to see more
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
