import type { Metadata } from 'next';
import { NavBar } from '@imajin/ui';
import './globals.css';
import { Providers } from './providers';

export const metadata: Metadata = {
  title: 'Coffee | Imajin',
  description: 'Support creators with sovereign tip pages on the Imajin network',
  openGraph: {
    title: 'Coffee | Imajin',
    description: 'Support creators with sovereign tip pages on the Imajin network',
    siteName: 'Imajin',
    type: 'website',
  },
  twitter: {
    card: 'summary',
    title: 'Coffee | Imajin',
    description: 'Support creators with sovereign tip pages on the Imajin network',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const servicePrefix = process.env.NEXT_PUBLIC_SERVICE_PREFIX || 'https://';
  const domain = process.env.NEXT_PUBLIC_DOMAIN || 'imajin.ai';

  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-white dark:bg-surface-base text-primary dark:text-primary">
        <NavBar
          currentService="Coffee"
          servicePrefix={servicePrefix}
          domain={domain}
        />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
