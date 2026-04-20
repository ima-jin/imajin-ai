import { cookies } from 'next/headers';
import { verifySessionToken, getSessionCookieOptions } from '@/src/lib/auth/jwt';
import { db, registryApps } from '@/src/db';
import { eq } from 'drizzle-orm';
import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import AppDetailClient from './components/AppDetailClient';

export default async function AppDetailPage({
  params,
}: {
  params: { appId: string };
}) {
  const cookieConfig = getSessionCookieOptions();
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(cookieConfig.name)?.value;

  let sessionDid: string | null = null;
  if (sessionToken) {
    const session = await verifySessionToken(sessionToken);
    sessionDid = session?.sub ?? null;
  }

  if (!sessionDid) {
    redirect('/auth/login');
  }

  const [app] = await db
    .select()
    .from(registryApps)
    .where(eq(registryApps.id, params.appId));

  if (!app) {
    notFound();
  }

  if (app.ownerDid !== sessionDid) {
    redirect('/auth/developer/apps');
  }

  return (
    <div className="space-y-4">
      <div>
        <Link
          href="/auth/developer/apps"
          className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          ← Developer Apps
        </Link>
      </div>
      <AppDetailClient app={app} />
    </div>
  );
}
