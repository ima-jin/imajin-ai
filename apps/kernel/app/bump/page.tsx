import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { verifySessionToken, getSessionCookieOptions } from '@/src/lib/auth/jwt';
import BumpPageClient from './client';

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
