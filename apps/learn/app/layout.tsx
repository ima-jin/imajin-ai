import type { Metadata } from 'next';
import { NavBar } from '@imajin/ui';
import './globals.css';

const SERVICE_PREFIX = process.env.NEXT_PUBLIC_SERVICE_PREFIX || 'https://';
const DOMAIN = process.env.NEXT_PUBLIC_DOMAIN || 'imajin.ai';

export const metadata: Metadata = {
  title: 'Learn | Imajin',
  description: 'AI workshops for humans. No hype, just skills.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-black text-white">
        <NavBar
          currentService="Learn"
          servicePrefix={SERVICE_PREFIX}
          domain={DOMAIN}
        />
        <main className="max-w-4xl mx-auto px-4 py-8">
          {children}
        </main>
      </body>
    </html>
  );
}
