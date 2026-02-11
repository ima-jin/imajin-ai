import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Fixready | Imajin',
  description: 'Imajin Fixready',
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
