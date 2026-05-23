import type { Metadata, Viewport } from 'next';
import { buildServiceMetadata, defaultViewport } from '@imajin/ui';
import './globals.css';
import { Providers } from './providers';
export const viewport: Viewport = defaultViewport;
export const metadata: Metadata = buildServiceMetadata('Dykil', 'Sovereign surveys and forms on the Imajin network');

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-white dark:bg-gray-950 text-gray-900 dark:text-gray-100">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
