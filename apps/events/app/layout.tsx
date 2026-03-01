import type { Metadata } from 'next';
import './globals.css';
import { NavBar } from './components/NavBar';

const prefix = process.env.NEXT_PUBLIC_SERVICE_PREFIX || 'https://';
const domain = process.env.NEXT_PUBLIC_DOMAIN || 'imajin.ai';
const isDev = prefix.includes('dev-');
const envLabel = isDev ? ' [DEV]' : '';

export const metadata: Metadata = {
  title: {
    default: `Imajin Events${envLabel}`,
    template: `%s | Imajin Events${envLabel}`,
  },
  description: 'Create and discover events on the sovereign network. No platform lock-in. You own your identity.',
  keywords: ['events', 'tickets', 'sovereign', 'decentralized', 'imajin'],
  authors: [{ name: 'Imajin', url: `${prefix}www.${domain}` }],
  openGraph: {
    type: 'website',
    locale: 'en_US',
    url: `${prefix}events.${domain}`,
    siteName: `Imajin Events${envLabel}`,
    title: `Imajin Events${envLabel}`,
    description: 'Create and discover events on the sovereign network',
  },
  twitter: {
    card: 'summary_large_image',
    title: `Imajin Events${envLabel}`,
    description: 'Create and discover events on the sovereign network',
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
      <body className="min-h-screen bg-[#0a0a0a] text-white">
        <NavBar currentService="Events" />
        <main className="container mx-auto px-4 py-8">
          {children}
        </main>
      </body>
    </html>
  );
}
