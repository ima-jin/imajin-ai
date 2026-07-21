import { db, registryApps } from '@/src/db';
import { eq, desc } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { getEffectiveDid } from '@/app/auth/lib/get-effective-did';
import DevAppsShell from './components/DevAppsShell';

export default async function DeveloperAppsPage() {
  const { sessionDid, effectiveDid } = await getEffectiveDid();

  if (!sessionDid) {
    redirect('/auth/login');
  }

  // Scope the list to the DID the developer is currently acting as
  // (x-acting-as cookie), falling back to their own session DID. Matches the
  // ownerDid written at registration time via resolveActingDid() so the
  // create-path and list-path agree. (#DID-scoping fix)
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
    .where(eq(registryApps.ownerDid, effectiveDid!))
    .orderBy(desc(registryApps.createdAt));

  return <DevAppsShell apps={apps} />;
}
