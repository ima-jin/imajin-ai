const BADGE_PALETTE = [
  'bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-400',
  'bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-400',
  'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400',
  'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-400',
  'bg-cyan-100 dark:bg-cyan-900/40 text-cyan-700 dark:text-cyan-400',
  'bg-pink-100 dark:bg-pink-900/40 text-pink-700 dark:text-pink-400',
  'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400',
  'bg-teal-100 dark:bg-teal-900/40 text-teal-700 dark:text-teal-400',
];

/** Stable across pages and reloads, including for apps registered after the build. */
export function serviceBadgeClass(service: string): string {
  let hash = 0;
  for (const char of service) hash = (Math.imul(hash, 31) + char.codePointAt(0)!) >>> 0;
  return BADGE_PALETTE[hash % BADGE_PALETTE.length];
}
