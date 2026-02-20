import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: {
    default: 'Imajin — Sovereign Technology',
    template: '%s | Imajin',
  },
  description: 'Own your data. Own your identity. Own your devices. Exit infrastructure for the sovereign individual.',
  keywords: ['sovereign', 'decentralized', 'identity', 'self-hosted', 'no-subscription', 'imajin'],
  authors: [{ name: 'Imajin', url: 'https://imajin.ai' }],
  openGraph: {
    type: 'website',
    locale: 'en_US',
    url: 'https://imajin.ai',
    siteName: 'Imajin',
    title: 'Imajin — Sovereign Technology',
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
    title: 'Imajin — Sovereign Technology',
    description: 'Own your data. Own your identity. Own your devices.',
    images: ['/og-image.png'],
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
