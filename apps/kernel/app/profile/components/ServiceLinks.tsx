import { AskButton } from './AskButton';
import { buildPublicUrl } from '@imajin/config';
import type { ProfileData } from '../lib/types';

interface ServiceLinksProps {
  profile: ProfileData;
  viewerDid: string | null;
}

export function ServiceLinks({ profile, viewerDid }: ServiceLinksProps) {
  return (
    <div className="flex justify-center gap-3 mb-6 flex-wrap">
      <AskButton
        targetDid={profile.did}
        targetName={profile.displayName}
        targetHandle={profile.handle}
        inferenceEnabled={!!profile.featureToggles?.inference_enabled}
        canAsk={!!viewerDid}
      />
      {profile.featureToggles?.links && (
        <a
          href={`${buildPublicUrl('links')}/${profile.featureToggles.links}`}
          className="px-4 py-2 bg-gray-900 border border-gray-800 rounded-lg hover:bg-gray-800 transition text-white text-sm font-medium"
        >
          🔗 Links
        </a>
      )}
      {profile.featureToggles?.coffee && (
        <a
          href={`${buildPublicUrl('coffee')}/${profile.featureToggles.coffee}`}
          className="px-4 py-2 bg-[#F59E0B]/10 border-[#F59E0B]/30 text-[#F59E0B] rounded-lg hover:bg-[#F59E0B]/20 transition border text-sm font-medium"
        >
          ☕ Tip Me
        </a>
      )}
    </div>
  );
}
