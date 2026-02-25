import type { Metadata } from 'next';
import './globals.css';
import { NavBar } from './components/NavBar';

export const metadata: Metadata = {
  title: {
    default: 'Imajin Profiles',
    template: '%s | Imajin',
  },
  description: 'Sovereign identity profiles on the Imajin network. Own your identity, own your data.',
  keywords: ['profile', 'identity', 'sovereign', 'DID', 'imajin'],
  openGraph: {
    type: 'website',
    url: 'https://profile.imajin.ai',
    siteName: 'Imajin Profiles',
    title: 'Imajin Profiles',
    description: 'Sovereign identity profiles on the Imajin network.',
  },
  twitter: {
    card: 'summary',
    title: 'Imajin Profiles',
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
        <NavBar currentService="Profile" />
        <main className="container mx-auto px-4 py-8">
          {children}
        </main>
      </body>
    </html>
  );
}
