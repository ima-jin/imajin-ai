import { resolveRegistryAppBaseUrl } from '@/src/lib/apps/registry-url';

/** Optional events integration: no active registration means there is nothing to migrate. */
export async function migrateOnboardTickets(email: string, hardDid: string): Promise<void> {
  const base = await resolveRegistryAppBaseUrl('events');
  if (!base) return;
  await fetch(`${base}/api/migrate-tickets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, hardDid }),
    redirect: 'error',
  });
}
