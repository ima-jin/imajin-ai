import type { Metadata } from 'next';
import './globals.css';

const prefix = process.env.NEXT_PUBLIC_SERVICE_PREFIX || 'https://';
const domain = process.env.NEXT_PUBLIC_DOMAIN || 'imajin.ai';
const isDev = prefix.includes('dev-');
const envLabel = isDev ? ' [DEV]' : '';

export const metadata: Metadata = {
  title: `Imajin Media${envLabel}`,
  description: 'Sovereign media storage with .fair attribution and authenticated delivery.',
  keywords: ['media', 'storage', 'assets', 'fair', 'attribution', 'imajin'],
  openGraph: {
    type: 'website',
    url: `${prefix}media.${domain}`,
    siteName: `Imajin Media${envLabel}`,
    title: `Imajin Media${envLabel}`,
    description: 'Sovereign media storage with .fair attribution and authenticated delivery.',
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
        <main className="container mx-auto px-4 py-8">
          {children}
        </main>
      </body>
    </html>
  );
}
