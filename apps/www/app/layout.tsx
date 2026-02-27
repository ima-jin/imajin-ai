import './globals.css';
import type { Metadata } from 'next';
import { NavBar } from './components/NavBar';

const prefix = process.env.NEXT_PUBLIC_SERVICE_PREFIX || 'https://';
const domain = process.env.NEXT_PUBLIC_DOMAIN || 'imajin.ai';
const isDev = prefix.includes('dev-');
const envLabel = isDev ? ' [DEV]' : '';

export const metadata: Metadata = {
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
      </body>
    </html>
  );
}
