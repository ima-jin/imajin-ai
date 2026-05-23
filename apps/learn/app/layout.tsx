import type { Metadata, Viewport } from 'next';
import { NavBar, buildServiceMetadata, defaultViewport, getServiceRuntimeEnv } from '@imajin/ui';
import './globals.css';
import { Providers } from './providers';
export const viewport: Viewport = defaultViewport;
export const metadata: Metadata = buildServiceMetadata('Learn', 'Courses and lessons on the Imajin network — teach and learn, sovereign and DID-linked');

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const { servicePrefix, domain } = getServiceRuntimeEnv();

  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-white dark:bg-gray-950 text-gray-900 dark:text-gray-100">
        <NavBar
          currentService="Learn"
          servicePrefix={servicePrefix}
          domain={domain}
        />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
