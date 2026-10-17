import type { LauncherEntry } from '@/src/lib/kernel/launcher';

/** Existing launcher listing, not a second app catalog or manifest. */
export async function loadRegistryAppOptions(): Promise<LauncherEntry[]> {
  const response = await fetch('/registry/api/launcher');
  if (!response.ok) throw new Error('Failed to load registry apps');
  const body = await response.json() as { services?: LauncherEntry[] };
  return (body.services ?? []).filter((entry) => entry.source === 'registry');
}
