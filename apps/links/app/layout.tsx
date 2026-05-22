import type { Metadata, Viewport } from 'next';
import { NavBar, buildServiceMetadata, defaultViewport, getServiceRuntimeEnv } from '@imajin/ui';
import { LayoutWrapper } from '@/components/LayoutWrapper';
import './globals.css';
import { Providers } from './providers';
export const viewport: Viewport = defaultViewport;
export const metadata: Metadata = buildServiceMetadata('Links', 'Sovereign link-in-bio pages on the Imajin network');

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { servicePrefix, domain } = getServiceRuntimeEnv();

  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-white dark:bg-gray-950 text-gray-900 dark:text-gray-100">
        <NavBar
          currentService="Links"
          servicePrefix={servicePrefix}
          domain={domain}
        />
        <Providers>
          <LayoutWrapper>
            {children}
          </LayoutWrapper>
        </Providers>
      </body>
    </html>
  );
}
