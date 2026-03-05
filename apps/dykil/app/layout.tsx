import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Dykil | Imajin',
  description: 'Sovereign surveys and forms on the Imajin network',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-white dark:bg-gray-950 text-gray-900 dark:text-gray-100">
        {children}
      </body>
    </html>
  );
}
