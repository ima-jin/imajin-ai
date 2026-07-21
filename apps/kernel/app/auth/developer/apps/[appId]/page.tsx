import { db, registryApps } from '@/src/db';
import { eq } from 'drizzle-orm';
import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { getEffectiveDid } from '@/app/auth/lib/get-effective-did';
import AppDetailClient from './components/AppDetailClient';

export default async function AppDetailPage({
  params,
}: Readonly<{
  params: { appId: string };
}>) {
  const { sessionDid, effectiveDid } = await getEffectiveDid();

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

  // Ownership is scoped to the acting DID (x-acting-as), matching the list
  // page and the ownerDid written at registration via resolveActingDid().
  if (app.ownerDid !== effectiveDid) {
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
