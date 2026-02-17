import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Imajin — Sovereign Technology',
  description: 'Own your data. Own your identity. Own your devices.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
