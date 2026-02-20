import type { Metadata } from 'next';
import './globals.css';

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
    <html lang="en">
      <body className="min-h-screen bg-gradient-to-b from-gray-50 to-gray-100 dark:from-gray-900 dark:to-black">
        <main className="container mx-auto px-4 py-8">
          {children}
        </main>
      </body>
    </html>
  );
}
