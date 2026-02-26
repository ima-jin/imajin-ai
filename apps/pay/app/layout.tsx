import type { Metadata } from 'next';
import './globals.css';
import { NavBar } from './components/NavBar';

const prefix = process.env.NEXT_PUBLIC_SERVICE_PREFIX || 'https://';
const domain = process.env.NEXT_PUBLIC_DOMAIN || 'imajin.ai';
const isDev = prefix.includes('dev-');
const envLabel = isDev ? ' [DEV]' : '';

export const metadata: Metadata = {
  title: `Imajin Pay${envLabel}`,
  description: 'Unified payment infrastructure for the sovereign stack. Stripe + Solana. Your keys, your money.',
  keywords: ['payments', 'stripe', 'solana', 'sovereign', 'checkout', 'imajin'],
  openGraph: {
    type: 'website',
    url: `${prefix}pay.${domain}`,
    siteName: `Imajin Pay${envLabel}`,
    title: `Imajin Pay${envLabel} — Unified Payments`,
    description: 'Unified payment infrastructure for the sovereign stack. Stripe + Solana.',
  },
  twitter: {
    card: 'summary',
    title: `Imajin Pay${envLabel}`,
    description: 'Unified payment infrastructure for the sovereign stack.',
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
        <NavBar currentService="Pay" />
        <main className="container mx-auto px-4 py-8">
          {children}
        </main>
      </body>
    </html>
  );
}
