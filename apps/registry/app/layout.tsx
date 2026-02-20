import type { Metadata } from 'next';
import './globals.css';
import { NavBar } from './components/NavBar';

export const metadata: Metadata = {
  title: 'Imajin Registry',
  description: 'The phone book for the sovereign network. Federated node discovery and registration.',
  keywords: ['registry', 'nodes', 'federation', 'sovereign', 'imajin'],
  openGraph: {
    type: 'website',
    url: 'https://registry.imajin.ai',
    siteName: 'Imajin Registry',
    title: 'Imajin Registry — Node Federation',
    description: 'The phone book for the sovereign network. Register your node, discover others.',
  },
  twitter: {
    card: 'summary',
    title: 'Imajin Registry',
    description: 'The phone book for the sovereign network.',
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
        <NavBar currentService="Registry" />
        <main className="container mx-auto px-4 py-8">
          {children}
        </main>
      </body>
    </html>
  );
}
