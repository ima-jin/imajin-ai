import type { Metadata } from 'next';
import { NavBar, themeInitScript } from '@imajin/ui';
import { IdentityProvider } from './context/IdentityContext';
import './globals.css';
import { Providers } from './providers';

const prefix = process.env.NEXT_PUBLIC_SERVICE_PREFIX || 'https://';
const domain = process.env.NEXT_PUBLIC_DOMAIN || 'imajin.ai';
const isDev = prefix.includes('dev-');
const envLabel = isDev ? ' [DEV]' : '';

export const metadata: Metadata = {
  title: `Imajin Connections${envLabel}`,
  description: 'Trust-based connections on the Imajin network.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="min-h-screen bg-white dark:bg-[#0a0a0a] text-gray-900 dark:text-white">
        <NavBar currentService="Connections" servicePrefix={prefix} domain={domain} />
        <Providers>
          <IdentityProvider>
            <main className="container mx-auto px-4 py-8">
              {children}
            </main>
          </IdentityProvider>
        </Providers>
      </body>
    </html>
  );
}
