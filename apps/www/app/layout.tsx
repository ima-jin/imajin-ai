import './globals.css';
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { NavBar } from './components/NavBar';
import { BugReportButton } from '@/components/bug-report-button';

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

const prefix = process.env.NEXT_PUBLIC_SERVICE_PREFIX || 'https://';
const domain = process.env.NEXT_PUBLIC_DOMAIN || 'imajin.ai';
const isDev = prefix.includes('dev-');
const envLabel = isDev ? ' [DEV]' : '';

export const metadata: Metadata = {
  metadataBase: new URL(`${prefix}www.${domain}`),
  title: {
    default: `Imajin — Sovereign Technology${envLabel}`,
    template: `%s | Imajin${envLabel}`,
  },
  description: 'Own your data. Own your identity. Own your devices. Exit infrastructure for the sovereign individual.',
  keywords: ['sovereign', 'decentralized', 'identity', 'self-hosted', 'no-subscription', 'imajin'],
  authors: [{ name: 'Imajin', url: `${prefix}www.${domain}` }],
  openGraph: {
    type: 'website',
    locale: 'en_US',
    url: `${prefix}www.${domain}`,
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
    <html lang="en" className="dark">
      <body className="min-h-screen antialiased bg-[#0a0a0a] text-white">
        <NavBar currentService="Home" />
        {children}
        <BugReportWidget />
      </body>
    </html>
  );
}
