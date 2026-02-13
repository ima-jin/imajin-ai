import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Imajin Auth',
  description: 'Sovereign identity for humans and agents',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
