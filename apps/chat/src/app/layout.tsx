import type { Metadata } from 'next';
import './globals.css';
import { NavBar } from './components/NavBar';
import { IdentityProvider } from '@/contexts/IdentityContext';

const prefix = process.env.NEXT_PUBLIC_SERVICE_PREFIX || 'https://';
const domain = process.env.NEXT_PUBLIC_DOMAIN || 'imajin.ai';
const isDev = prefix.includes('dev-');
const envLabel = isDev ? ' [DEV]' : '';

export const metadata: Metadata = {
  title: `Imajin Chat${envLabel}`,
  description: 'End-to-end encrypted messaging for the trust network. X25519 + XChaCha20-Poly1305.',
  keywords: ['chat', 'messaging', 'encrypted', 'E2EE', 'sovereign', 'imajin'],
  openGraph: {
    type: 'website',
    url: `${prefix}chat.${domain}`,
    siteName: `Imajin Chat${envLabel}`,
    title: `Imajin Chat${envLabel} — Encrypted Messaging`,
    description: 'End-to-end encrypted messaging for the trust network.',
  },
  twitter: {
    card: 'summary',
    title: `Imajin Chat${envLabel}`,
    description: 'End-to-end encrypted messaging for the trust network.',
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
        <NavBar currentService="Chat" />
        <IdentityProvider>
          <main className="container mx-auto px-4 py-8">
            {children}
          </main>
        </IdentityProvider>
      </body>
    </html>
  );
}
