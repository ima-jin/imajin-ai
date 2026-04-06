import type { Metadata } from 'next';
import './globals.css';
import { NavBarWithUnread } from './components/NavBarWithUnread';
import { IdentityProvider } from '@/src/contexts/IdentityContext';
import { UnreadTitleManager } from './components/UnreadTitleManager';
import { UnreadCountProvider } from '@/src/contexts/UnreadCountContext';
import { ToastProvider, themeInitScript } from '@imajin/ui';
import { buildPublicUrl } from '@imajin/config';

const prefix = process.env.NEXT_PUBLIC_SERVICE_PREFIX || 'https://';
const domain = process.env.NEXT_PUBLIC_DOMAIN || 'imajin.ai';
const isDev = prefix.includes('dev-');
const envLabel = isDev ? ' [DEV]' : '';

export const metadata: Metadata = {
  title: `Imajin Chat${envLabel}`,
  description: 'End-to-end encrypted messaging for the trust network. X25519 + XChaCha20-Poly1305.',
  keywords: ['chat', 'messaging', 'encrypted', 'E2EE', 'sovereign', 'imajin'],
  openGraph: {
    type: 'website',
    url: buildPublicUrl('chat', prefix, domain),
    siteName: `Imajin Chat${envLabel}`,
    title: `Imajin Chat${envLabel} — Encrypted Messaging`,
    description: 'End-to-end encrypted messaging for the trust network.',
  },
  twitter: {
    card: 'summary',
    title: `Imajin Chat${envLabel}`,
    description: 'End-to-end encrypted messaging for the trust network.',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="h-screen bg-white dark:bg-[#0a0a0a] text-gray-900 dark:text-white">
        <ToastProvider>
          <UnreadCountProvider>
            <NavBarWithUnread />
            <IdentityProvider>
              <UnreadTitleManager />
              <main className="container mx-auto px-4 py-4">
                {children}
              </main>
            </IdentityProvider>
          </UnreadCountProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
