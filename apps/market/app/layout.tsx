import type { Metadata, Viewport } from 'next';
import { NavBar, themeInitScript } from '@imajin/ui';
import './globals.css';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export const metadata: Metadata = {
  title: 'Market | Imajin',
  description: 'Local commerce — buy and sell with trust on the Imajin network',
  openGraph: {
    title: 'Market | Imajin',
    description: 'Local commerce — buy and sell with trust on the Imajin network',
    siteName: 'Imajin',
    type: 'website',
  },
  twitter: {
    card: 'summary',
    title: 'Market | Imajin',
    description: 'Local commerce — buy and sell with trust on the Imajin network',
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
    <html lang="en">
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="min-h-screen bg-white dark:bg-gray-950 text-gray-900 dark:text-gray-100">
        <NavBar
          currentService="Market"
          servicePrefix={servicePrefix}
          domain={domain}
        />
        {children}
      </body>
    </html>
  );
}
