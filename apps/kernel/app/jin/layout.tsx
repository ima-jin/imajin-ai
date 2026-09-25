import type { Metadata, Viewport } from 'next';
import { getEffectiveDid } from '@/app/auth/lib/get-effective-did';
import { ActAsBanner } from './act-as-banner';

// #2291 — phone push path: a PWA manifest scoped to /jin so it can be
// installed to a phone home screen independently of the rest of the site.
// Next.js's file-convention `manifest.ts` only supports one, app-root-wide
// manifest — nested per-route manifests aren't supported — so this is a
// static file (public/jin/manifest.webmanifest) referenced here via the
// Metadata API's `manifest` field, which renders the <link rel="manifest">
// tag for every route under /jin without touching the root layout or any
// other route's metadata.
export const metadata: Metadata = {
  manifest: '/jin/manifest.webmanifest',
};

export const viewport: Viewport = {
  themeColor: '#0a0a0a',
};

/**
 * #2359: every /jin lane carries the act-as banner, resolved here rather
 * than per-panel so no lane can be reached without it. `getEffectiveDid`
 * reads the session cookie plus the `x-acting-for`/`x-acting-as` cookies
 * — the same precedence `resolveActingDid` applies server-side — and
 * `ActAsBanner` renders nothing when the two DIDs agree, so the normal
 * case is unchanged. Reading cookies makes this layout dynamic, which is
 * correct: an act-as banner must never be served from a cached shell.
 */
export default async function JinLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const { sessionDid, effectiveDid } = await getEffectiveDid();

  return (
    <>
      <ActAsBanner sessionDid={sessionDid} actingDid={effectiveDid} />
      {children}
    </>
  );
}
