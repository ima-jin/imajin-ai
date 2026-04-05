import './globals.css';
import type { Metadata } from 'next';
import { themeInitScript } from '@imajin/ui';
import { cookies } from 'next/headers';
import { NavBar } from './components/NavBar';
import { BugReportButton } from '@/components/bug-report-button';
import { Providers } from './providers';

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';
import { SESSION_COOKIE_NAME as SESSION_COOKIE } from '@imajin/config';

async function BugReportWidget() {
  const cookieStore = cookies();
  const session = cookieStore.get(SESSION_COOKIE);
  if (!session) return null;
  try {
    const res = await fetch(`${AUTH_SERVICE_URL}/api/session`, {
      headers: { Cookie: `${SESSION_COOKIE}=${session.value}` },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return <BugReportButton />;
  } catch {
    return null;
  }
}

import { buildPublicUrl } from '@imajin/config';

const prefix = process.env.NEXT_PUBLIC_SERVICE_PREFIX || 'https://';
const domain = process.env.NEXT_PUBLIC_DOMAIN || 'imajin.ai';
const isDev = prefix.includes('dev-');
const envLabel = isDev ? ' [DEV]' : '';
const wwwUrl = buildPublicUrl('www', prefix, domain);

export const metadata: Metadata = {
  metadataBase: new URL(wwwUrl),
  title: {
    default: `Imajin — Sovereign Technology${envLabel}`,
    template: `%s | Imajin${envLabel}`,
  },
  description: 'Own your data. Own your identity. Own your devices. Exit infrastructure for the sovereign individual.',
  keywords: ['sovereign', 'decentralized', 'identity', 'self-hosted', 'no-subscription', 'imajin'],
  authors: [{ name: 'Imajin', url: wwwUrl }],
  openGraph: {
    type: 'website',
    locale: 'en_US',
    url: wwwUrl,
    siteName: `Imajin${envLabel}`,
    title: `Imajin — Sovereign Technology${envLabel}`,
    description: 'Own your data. Own your identity. Own your devices. No subscriptions. No cloud dependency. No surveillance capitalism.',
    images: [
      {
        url: '/og-image.png',
        width: 1200,
        height: 630,
        alt: 'Imajin — Sovereign Technology',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: `Imajin — Sovereign Technology${envLabel}`,
    description: 'Own your data. Own your identity. Own your devices.',
    images: ['/og-image.png'],
  },
  robots: {
    index: !isDev,
    follow: !isDev,
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="min-h-screen antialiased bg-white dark:bg-[#0a0a0a] text-gray-900 dark:text-white">
        <NavBar currentService="Home" />
        <Providers>{children}</Providers>
        <BugReportWidget />
      </body>
    </html>
  );
}
