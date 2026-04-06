import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Imajin Kernel',
  description: 'Imajin unified kernel',
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
