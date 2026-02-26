import type { Metadata } from 'next';
import './globals.css';
import { NavBar } from './components/NavBar';

const prefix = process.env.NEXT_PUBLIC_SERVICE_PREFIX || 'https://';
const domain = process.env.NEXT_PUBLIC_DOMAIN || 'imajin.ai';
const isDev = prefix.includes('dev-');
const envLabel = isDev ? ' [DEV]' : '';

export const metadata: Metadata = {
  title: `Imajin Registry${envLabel}`,
  description: 'The phone book for the sovereign network. Federated node discovery and registration.',
  keywords: ['registry', 'nodes', 'federation', 'sovereign', 'imajin'],
  openGraph: {
    type: 'website',
    url: `${prefix}registry.${domain}`,
    siteName: `Imajin Registry${envLabel}`,
    title: `Imajin Registry${envLabel} — Node Federation`,
    description: 'The phone book for the sovereign network. Register your node, discover others.',
  },
  twitter: {
    card: 'summary',
    title: `Imajin Registry${envLabel}`,
    description: 'The phone book for the sovereign network.',
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
        <NavBar currentService="Registry" />
        <main className="container mx-auto px-4 py-8">
          {children}
        </main>
      </body>
    </html>
  );
}
