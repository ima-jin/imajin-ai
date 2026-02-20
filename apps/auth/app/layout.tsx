import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Imajin Auth',
  description: 'Sovereign identity for humans, agents, and devices. Ed25519 keypairs. You hold the private key.',
  keywords: ['identity', 'authentication', 'sovereign', 'DID', 'keypair', 'imajin'],
  openGraph: {
    type: 'website',
    url: 'https://auth.imajin.ai',
    siteName: 'Imajin Auth',
    title: 'Imajin Auth — Sovereign Identity',
    description: 'Sovereign identity for humans, agents, and devices. No passwords. No OAuth. Just cryptography.',
  },
  twitter: {
    card: 'summary',
    title: 'Imajin Auth',
    description: 'Sovereign identity for humans, agents, and devices.',
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
        <main className="container mx-auto px-4 py-8">
          {children}
        </main>
      </body>
    </html>
  );
}
