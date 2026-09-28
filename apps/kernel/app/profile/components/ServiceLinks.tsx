import { AskButton } from './AskButton';
import { buildPublicUrl } from '@imajin/config';
import type { ProfileData } from '../lib/types';
import { isAppEnabled } from '@/src/lib/profile/feature-toggles-compat';

interface ServiceLinksProps {
  profile: ProfileData;
  viewerDid: string | null;
}

export function ServiceLinks({ profile, viewerDid }: Readonly<ServiceLinksProps>) {
  // Registry read (#2425): enabled-ness comes from the compat mapper
  // (unions the legacy per-app FeatureToggles fields with the generic
  // `enabledApps`), not a direct `featureToggles.links`/`.coffee` check.
  // The destination path segment was always the profile's own `handle`
  // (see `apps/kernel/app/profile/edit/page.tsx`'s write path) — never a
  // distinct per-app value — so building it from `profile.handle` directly
  // is equivalent, not a behavior change.
  const linksEnabled = isAppEnabled(profile.featureToggles, 'links');
  const coffeeEnabled = isAppEnabled(profile.featureToggles, 'coffee');

  return (
    <div className="flex justify-center gap-3 mb-6 flex-wrap">
      <AskButton
        targetDid={profile.did}
        targetName={profile.displayName}
        targetHandle={profile.handle}
        inferenceEnabled={!!profile.featureToggles?.inference_enabled}
        canAsk={!!viewerDid}
      />
      {linksEnabled && (
        <a
          href={`${buildPublicUrl('links')}/${profile.handle}`}
          className="px-4 py-2 bg-gray-900 border border-gray-800 rounded-lg hover:bg-gray-800 transition text-white text-sm font-medium"
        >
          🔗 Links
        </a>
      )}
      {coffeeEnabled && (
        <a
          href={`${buildPublicUrl('coffee')}/${profile.handle}`}
          className="px-4 py-2 bg-[#F59E0B]/10 border-[#F59E0B]/30 text-[#F59E0B] rounded-lg hover:bg-[#F59E0B]/20 transition border text-sm font-medium"
        >
          ☕ Tip Me
        </a>
      )}
    </div>
  );
}
