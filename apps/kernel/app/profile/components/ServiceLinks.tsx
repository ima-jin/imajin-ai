import { AskButton } from './AskButton';
import { buildPublicUrl } from '@imajin/config';
import type { ProfileData } from '../lib/types';
import type { NavApp } from '@/src/lib/kernel/app-nav';

interface ServiceLinksProps {
  profile: ProfileData;
  viewerDid: string | null;
  /**
   * Registry apps ∩ resolveEnabledApps for this profile (#2425 send-back) —
   * resolved once, server-side, by the page (see
   * `resolveRegistryAppsBySlug`'s docblock for why this stays a plain prop
   * rather than a query this component makes itself: enabled-ness is a
   * PROFILE OWNER decision, not something tied to the current viewer).
   * Rendered generically; this component no longer hard-codes which app
   * slugs exist.
   */
  apps: readonly NavApp[];
}

export function ServiceLinks({ profile, viewerDid, apps }: Readonly<ServiceLinksProps>) {
  return (
    <div className="flex justify-center gap-3 mb-6 flex-wrap">
      <AskButton
        targetDid={profile.did}
        targetName={profile.displayName}
        targetHandle={profile.handle}
        inferenceEnabled={!!profile.featureToggles?.inference_enabled}
        canAsk={!!viewerDid}
      />
      {apps.map((app) => (
        <a
          key={app.slug}
          // The destination path segment was always the profile's own
          // `handle` (see `apps/kernel/app/profile/edit/page.tsx`'s write
          // path) — never a distinct per-app value.
          href={`${buildPublicUrl(app.slug)}/${profile.handle}`}
          className="px-4 py-2 bg-gray-900 border border-gray-800 rounded-lg hover:bg-gray-800 transition text-white text-sm font-medium"
        >
          {app.icon} {app.name}
        </a>
      ))}
    </div>
  );
}
