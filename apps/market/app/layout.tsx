import type { Metadata, Viewport } from 'next';
import { NavBar, themeInitScript, buildServiceMetadata, defaultViewport, getServiceRuntimeEnv } from '@imajin/ui';
import './globals.css';
export const viewport: Viewport = defaultViewport;
export const metadata: Metadata = buildServiceMetadata('Market', 'Local commerce — buy and sell with trust on the Imajin network');

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const { servicePrefix, domain } = getServiceRuntimeEnv();

  return (
    <html lang="en">
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="min-h-screen bg-white dark:bg-gray-950 text-gray-900 dark:text-gray-100">
        <NavBar
          currentService="Market"
          servicePrefix={servicePrefix}
          domain={domain}
        />
        {children}
      </body>
    </html>
  );
}
