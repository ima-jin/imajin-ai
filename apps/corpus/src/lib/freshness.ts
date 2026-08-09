import type { CorpusSourceFreshness } from '../engine/types';

export const DEFAULT_STALE_AFTER_DAYS = 7;

export function addFreshnessWarnings(
  sources: CorpusSourceFreshness[],
  now: Date = new Date(),
  staleAfterDays = DEFAULT_STALE_AFTER_DAYS,
): CorpusSourceFreshness[] {
  const staleAfterMs = staleAfterDays * 24 * 60 * 60 * 1000;

  return sources.map(source => {
    const lastSyncMs = Date.parse(source.lastSync);
    if (Number.isNaN(lastSyncMs)) {
      return { ...source, warning: 'last_sync_invalid' };
    }

    if (now.getTime() - lastSyncMs > staleAfterMs) {
      return { ...source, warning: 'stale' };
    }

    return source;
  });
}
