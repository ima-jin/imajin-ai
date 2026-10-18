import { and, eq } from 'drizzle-orm';
import { db, registryApps } from '@/src/db';

/** Kernel features are not apps; app folders use their active registration's display metadata. */
const FEATURE_FOLDERS: Record<string, { name: string; icon: string }> = {
  bugs: { name: 'Bug Reports', icon: '🐛' },
  chat: { name: 'Chat', icon: '💬' },
  profile: { name: 'Profile', icon: '👤' },
  voice: { name: 'Audio Recordings', icon: '🎙️' },
  signed: { name: 'Signed Documents', icon: '📝' },
};

export async function resolveContextFolder(context: { feature?: string; app?: string }): Promise<{ name: string; icon: string } | null> {
  const key = context.feature || context.app;
  if (!key) return null;
  if (Object.hasOwn(FEATURE_FOLDERS, key)) return FEATURE_FOLDERS[key];
  const [app] = await db.select({
    name: registryApps.name, icon: registryApps.icon, status: registryApps.status,
  }).from(registryApps).where(and(eq(registryApps.slug, key), eq(registryApps.status, 'active'))).limit(1);
  return app?.status === 'active' ? { name: app.name, icon: app.icon || '📁' } : null;
}
