import type { Metadata, Viewport } from 'next';

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

export default function JinLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
