import type { Metadata } from 'next';
import './globals.css';

import { buildPublicUrl } from '@imajin/config';

const prefix = process.env.NEXT_PUBLIC_SERVICE_PREFIX || 'https://';
const isDev = prefix.includes('dev-');
const envLabel = isDev ? ' [DEV]' : '';

export const metadata: Metadata = {
  title: `Imajin Input${envLabel}`,
  description: 'Voice transcription and file upload processing for the Imajin network.',
  keywords: ['input', 'transcription', 'upload', 'voice', 'imajin'],
  openGraph: {
    type: 'website',
    url: buildPublicUrl('input'),
    siteName: `Imajin Input${envLabel}`,
    title: `Imajin Input${envLabel}`,
    description: 'Voice transcription and file upload processing for the Imajin network.',
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
