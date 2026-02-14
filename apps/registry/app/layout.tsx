import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Imajin Registry',
  description: 'The phone book for the sovereign network',
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
