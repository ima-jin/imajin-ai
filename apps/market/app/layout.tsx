import type { Metadata, Viewport } from 'next';
import { NavBar } from '@imajin/ui';
import { themeInitScript, buildServiceMetadata, defaultViewport, getServiceRuntimeEnv } from '@imajin/ui/server';
import { APP_DISPLAY_NAME } from '@imajin/config';
import './globals.css';
export const viewport: Viewport = defaultViewport;
export const metadata: Metadata = buildServiceMetadata('Market', `Local commerce — buy and sell with trust on the ${APP_DISPLAY_NAME} network`);

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
