import type { Metadata } from 'next';
import { NavBar } from '@imajin/ui';
import './globals.css';
import { Providers } from './providers';

export const metadata: Metadata = {
  title: 'Learn | Imajin',
  description: 'Courses and lessons on the Imajin network — teach and learn, sovereign and DID-linked',
  openGraph: {
    title: 'Learn | Imajin',
    description: 'Courses and lessons on the Imajin network — teach and learn, sovereign and DID-linked',
    siteName: 'Imajin',
    type: 'website',
  },
  twitter: {
    card: 'summary',
    title: 'Learn | Imajin',
    description: 'Courses and lessons on the Imajin network — teach and learn, sovereign and DID-linked',
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
          currentService="Learn"
          servicePrefix={servicePrefix}
          domain={domain}
        />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
