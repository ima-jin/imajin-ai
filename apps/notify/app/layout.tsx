import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Notifications | Imajin',
  description: 'Notification service for the Imajin network',
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
