import type { Metadata } from 'next';
import './globals.css';
import { NavBar } from './components/NavBar';

export const metadata: Metadata = {
  title: 'Imajin Pay',
  description: 'Unified payment infrastructure for the sovereign stack. Stripe + Solana. Your keys, your money.',
  keywords: ['payments', 'stripe', 'solana', 'sovereign', 'checkout', 'imajin'],
  openGraph: {
    type: 'website',
    url: 'https://pay.imajin.ai',
    siteName: 'Imajin Pay',
    title: 'Imajin Pay — Unified Payments',
    description: 'Unified payment infrastructure for the sovereign stack. Stripe + Solana.',
  },
  twitter: {
    card: 'summary',
    title: 'Imajin Pay',
    description: 'Unified payment infrastructure for the sovereign stack.',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-gradient-to-b from-gray-50 to-gray-100 dark:from-gray-900 dark:to-black">
        <NavBar currentService="Pay" />
        <main className="container mx-auto px-4 py-8">
          {children}
        </main>
      </body>
    </html>
  );
}
