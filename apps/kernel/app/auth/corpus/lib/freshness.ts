/**
 * Freshness banding for corpus sources (#1731).
 *
 * The corpus service's own `warning` field (see
 * `apps/corpus/src/lib/freshness.ts`) only distinguishes "stale" (>7 days)
 * from "fine", using a boolean-ish presence check. The dashboard wants a
 * three-way band — green (<24h), yellow (24h–7d), red (>7d or unparseable) —
 * so this computes that band directly from `lastSync` on the client, and
 * surfaces the server's `warning` string as supplementary detail text when
 * present.
 */

export type FreshnessLevel = 'green' | 'yellow' | 'red';

export interface FreshnessInfo {
  level: FreshnessLevel;
  label: string;
  /** Present only for the red band — a short reason to show next to the source. */
  warningText?: string;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const STALE_AFTER_DAYS = 7;

export function computeFreshness(lastSync: string, now: Date = new Date()): FreshnessInfo {
  const lastSyncMs = Date.parse(lastSync);
  if (Number.isNaN(lastSyncMs)) {
    return { level: 'red', label: 'Unknown', warningText: 'Last sync time is invalid.' };
  }

  const ageMs = now.getTime() - lastSyncMs;

  if (ageMs < DAY_MS) {
    return { level: 'green', label: 'Synced recently' };
  }

  if (ageMs < STALE_AFTER_DAYS * DAY_MS) {
    return { level: 'yellow', label: 'Sync ageing' };
  }

  const days = Math.floor(ageMs / DAY_MS);
  return {
    level: 'red',
    label: 'Stale',
    warningText: `Not synced in ${days} day${days === 1 ? '' : 's'} — data may be out of date.`,
  };
}
