import './globals.css';
import type { Metadata, Viewport } from 'next';
import { themeInitScript } from '@imajin/ui/server';
import { cookies } from 'next/headers';
import { NavBarWithUnread } from './components/NavBarWithUnread';
import { BugReportButton } from '@/src/components/www/bug-report-button';
import { Providers } from './providers';

import { getSessionFromCookies } from '@/src/lib/kernel/session';

async function BugReportWidget() {
  const cookieStore = await cookies();
  const session = await getSessionFromCookies(cookieStore.toString());
  if (!session) return null;
  return <BugReportButton />;
}

import { buildPublicUrl, APP_DISPLAY_NAME } from '@imajin/config';

const prefix = process.env.NEXT_PUBLIC_SERVICE_PREFIX || 'https://';
const domain = process.env.NEXT_PUBLIC_DOMAIN || 'imajin.ai';
const isDev = prefix.includes('dev-');
const envLabel = isDev ? ' [DEV]' : '';
const wwwUrl = buildPublicUrl('www', prefix, domain);
const title = `${APP_DISPLAY_NAME} — identity and authority for AI agents. · Alpha${envLabel}`;
const description = 'your agents act as themselves, on your authority, and every action is signed.';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export const metadata: Metadata = {
  metadataBase: new URL(wwwUrl),
  title: {
    default: title,
    template: `%s | ${APP_DISPLAY_NAME}${envLabel}`,
  },
  description,
  keywords: ['AI agents', 'agent identity', 'delegated authority', 'signed record', 'alpha', 'imajin'],
  authors: [{ name: APP_DISPLAY_NAME, url: wwwUrl }],
  openGraph: {
    type: 'website',
    locale: 'en_US',
    url: wwwUrl,
    siteName: `${APP_DISPLAY_NAME}${envLabel}`,
    title,
    description,
    images: [
      {
        url: '/og-image.png',
        width: 1200,
        height: 630,
        alt: 'Imajin · Alpha — identity and authority for AI agents.',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title,
    description,
    images: ['/og-image.png'],
  },
  robots: {
    index: !isDev,
    follow: !isDev,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="min-h-screen antialiased bg-white dark:bg-[#0a0a0a] text-gray-900 dark:text-white">
        <Providers>
          <NavBarWithUnread currentService="Home" />
          {children}
        </Providers>

      </body>
    </html>
  );
}
