import type { Metadata } from 'next';

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
      <body>{children}</body>
    </html>
  );
}
