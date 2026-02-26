import type { Metadata } from 'next';
import './globals.css';
import { NavBar } from './components/NavBar';
import { IdentityProvider } from './context/IdentityContext';

const prefix = process.env.NEXT_PUBLIC_SERVICE_PREFIX || 'https://';
const domain = process.env.NEXT_PUBLIC_DOMAIN || 'imajin.ai';
const isDev = prefix.includes('dev-');
const envLabel = isDev ? ' [DEV]' : '';

export const metadata: Metadata = {
  title: {
    default: `Imajin Profiles${envLabel}`,
    template: `%s | Imajin${envLabel}`,
  },
  description: 'Sovereign identity profiles on the Imajin network. Own your identity, own your data.',
  keywords: ['profile', 'identity', 'sovereign', 'DID', 'imajin'],
  openGraph: {
    type: 'website',
    url: `${prefix}profile.${domain}`,
    siteName: `Imajin Profiles${envLabel}`,
    title: `Imajin Profiles${envLabel}`,
    description: 'Sovereign identity profiles on the Imajin network.',
  },
  twitter: {
    card: 'summary',
    title: `Imajin Profiles${envLabel}`,
    description: 'Sovereign identity profiles on the Imajin network.',
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
        <IdentityProvider>
          <NavBar currentService="Profile" />
          <main className="container mx-auto px-4 py-8">
            {children}
          </main>
        </IdentityProvider>
      </body>
    </html>
  );
}
