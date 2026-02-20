import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Auth | Imajin',
  description: 'Sovereign identity for humans and agents',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-gradient-to-b from-gray-50 to-gray-100 dark:from-gray-900 dark:to-black">
        <main className="container mx-auto px-4 py-8">
          {children}
        </main>
      </body>
    </html>
  );
}
