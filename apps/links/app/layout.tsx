import type { Metadata, Viewport } from 'next';
import { NavBar } from '@imajin/ui';
import { LayoutWrapper } from '@/components/LayoutWrapper';
import './globals.css';
import { Providers } from './providers';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export const metadata: Metadata = {
  title: 'Links | Imajin',
  description: 'Sovereign link-in-bio pages on the Imajin network',
  openGraph: {
    title: 'Links | Imajin',
    description: 'Sovereign link-in-bio pages on the Imajin network',
    siteName: 'Imajin',
    type: 'website',
  },
  twitter: {
    card: 'summary',
    title: 'Links | Imajin',
    description: 'Sovereign link-in-bio pages on the Imajin network',
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
      <body className="min-h-screen bg-white dark:bg-gray-950 text-gray-900 dark:text-gray-100">
        <NavBar
          currentService="Links"
          servicePrefix={servicePrefix}
          domain={domain}
        />
        <Providers>
          <LayoutWrapper>
            {children}
          </LayoutWrapper>
        </Providers>
      </body>
    </html>
  );
}
