import { and, eq, isNull } from 'drizzle-orm';
import { db, mailSenders, registryApps } from '@/src/db';
import type { SenderConfig } from './types';
import { validateSenderConfig } from './validation';

/** App identity is meaningful only while actively registered. Never trust a supplied owner. */
export async function resolveMailOwner(ownerDid?: string, appDid?: string): Promise<string | undefined> {
  if (!appDid) return ownerDid;
  const [app] = await db.select({ ownerDid: registryApps.ownerDid }).from(registryApps).where(and(
    eq(registryApps.appDid, appDid), eq(registryApps.status, 'active'), isNull(registryApps.revokedAt),
  )).limit(1);
  if (!app || (ownerDid && app.ownerDid !== ownerDid)) throw new Error('Mail app owner mismatch or inactive app');
  return app.ownerDid;
}

export async function listSenderConfigs(ownerDid: string): Promise<SenderConfig[]> {
  return db.select().from(mailSenders).where(eq(mailSenders.ownerDid, ownerDid));
}

export async function saveSenderConfig(config: SenderConfig): Promise<void> {
  const valid = validateSenderConfig(config);
  await resolveMailOwner(valid.ownerDid, valid.appDid);
  await db.insert(mailSenders).values(valid).onConflictDoUpdate({
    target: [mailSenders.ownerDid, mailSenders.purpose, mailSenders.appDid],
    set: { domain: valid.domain, localPart: valid.localPart, displayName: valid.displayName, replyTo: valid.replyTo },
  });
}
