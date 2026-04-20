import { cookies } from 'next/headers';
import { verifySessionToken, getSessionCookieOptions } from '@/src/lib/auth/jwt';
import { db, registryApps } from '@/src/db';
import { eq, desc } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import DevAppsShell from './components/DevAppsShell';

export default async function DeveloperAppsPage() {
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

  const apps = await db
    .select({
      id: registryApps.id,
      name: registryApps.name,
      description: registryApps.description,
      appDid: registryApps.appDid,
      status: registryApps.status,
      requestedScopes: registryApps.requestedScopes,
      createdAt: registryApps.createdAt,
    })
    .from(registryApps)
    .where(eq(registryApps.ownerDid, sessionDid))
    .orderBy(desc(registryApps.createdAt));

  return <DevAppsShell apps={apps} />;
}
