import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { verifySessionToken, getSessionCookieOptions } from '@/src/lib/auth/jwt';
import type { Metadata } from 'next';
import BumpPageClient from './client';

export const metadata: Metadata = {
  title: 'Bump — connect in person',
  description: 'Bump phones to connect instantly. No QR codes, no typing.',
  openGraph: {
    title: 'Bump?',
    description: 'Bump phones to connect instantly.',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Bump?',
    description: 'Bump phones to connect instantly.',
  },
};

export default async function BumpPage() {
  const cookieConfig = getSessionCookieOptions();
  const cookieStore = await cookies();
  const token = cookieStore.get(cookieConfig.name)?.value;

  if (!token) {
    redirect('/auth/login?next=/bump');
  }

  const session = await verifySessionToken(token);
  if (!session) {
    redirect('/auth/login?next=/bump');
  }

  return <BumpPageClient />;
}
