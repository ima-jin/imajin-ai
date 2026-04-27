import type { Metadata } from 'next';
import './globals.css';
import { Providers } from './providers';

export const metadata: Metadata = {
  title: 'Dykil | Imajin',
  description: 'Sovereign surveys and forms on the Imajin network',
  openGraph: {
    title: 'Dykil | Imajin',
    description: 'Sovereign surveys and forms on the Imajin network',
    siteName: 'Imajin',
    type: 'website',
  },
  twitter: {
    card: 'summary',
    title: 'Dykil | Imajin',
    description: 'Sovereign surveys and forms on the Imajin network',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-white dark:bg-surface-base text-primary dark:text-primary">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
