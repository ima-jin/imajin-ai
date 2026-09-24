'use client';

/**
 * Per-service unread/attention badge counts (RFC-19 `set_badge`, #2275).
 *
 * `<ServiceEmbed>` and `<IdentityTabBar>` are siblings under
 * `AuthLayoutShell` (one renders the active tab's iframe, the other renders
 * the tab strip) with no shared parent state today. Threading badge counts
 * through `layout.tsx` (a server component) would mean re-fetching them
 * server-side on every navigation; a module-level store keeps this to a
 * client-only concern, consistent with the rest of the postMessage handling.
 */

type BadgeListener = (badges: Readonly<Record<string, number>>) => void;

let badges: Record<string, number> = {};
const listeners = new Set<BadgeListener>();

function notify(): void {
  for (const listener of listeners) {
    listener(badges);
  }
}

export function setServiceBadge(service: string, count: number): void {
  const next = count > 0 ? count : 0;
  if (badges[service] === next) return;
  badges = { ...badges, [service]: next };
  notify();
}

export function getServiceBadges(): Readonly<Record<string, number>> {
  return badges;
}

export function subscribeServiceBadges(listener: BadgeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only reset so suites don't leak badge state across test files. */
export function resetServiceBadges(): void {
  badges = {};
}
