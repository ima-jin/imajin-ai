import type { Metadata } from 'next';
import './globals.css';
import { NavBar } from './components/NavBar';

const prefix = process.env.NEXT_PUBLIC_SERVICE_PREFIX || 'https://';
const domain = process.env.NEXT_PUBLIC_DOMAIN || 'imajin.ai';
const isDev = prefix.includes('dev-');
const envLabel = isDev ? ' [DEV]' : '';

export const metadata: Metadata = {
  title: `Imajin Auth${envLabel}`,
  description: 'Sovereign identity for humans, agents, and devices. Ed25519 keypairs. You hold the private key.',
  keywords: ['identity', 'authentication', 'sovereign', 'DID', 'keypair', 'imajin'],
  openGraph: {
    type: 'website',
    url: `${prefix}auth.${domain}`,
    siteName: `Imajin Auth${envLabel}`,
    title: `Imajin Auth${envLabel} — Sovereign Identity`,
    description: 'Sovereign identity for humans, agents, and devices. No passwords. No OAuth. Just cryptography.',
  },
  twitter: {
    card: 'summary',
    title: `Imajin Auth${envLabel}`,
    description: 'Sovereign identity for humans, agents, and devices.',
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
        <NavBar currentService="Auth" />
        <main className="container mx-auto px-4 py-8">
          {children}
        </main>
      </body>
    </html>
  );
}
