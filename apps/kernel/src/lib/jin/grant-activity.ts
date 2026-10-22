import type { GrantCard } from './grants-lane';

export const APP_USAGE_RECORDING_STARTED_AT = '2026-10-22T00:00:00.000Z';
const UNUSED_MS = 30 * 24 * 60 * 60 * 1000;

/** Legacy memberships have no usage instrumentation and cannot be called unused. */
export function isGrantUnused30d(card: GrantCard, now = Date.now()): boolean {
  if (card.source === 'auth-membership' || card.status !== 'active') return false;
  if (card.expiresAt && Date.parse(card.expiresAt) <= now) return false;
  const reference = card.lastUsedAt ?? card.issuedAt;
  return reference !== null && Date.parse(reference) <= now - UNUSED_MS;
}

/** Preserve source positions; prioritize idle grants within each source only. */
export function sortGrantsByActivity(cards: GrantCard[], now = Date.now()): GrantCard[] {
  const newest = [...cards].sort((a, b) => (b.issuedAt ?? '').localeCompare(a.issuedAt ?? ''));
  const sources = new Map<string, GrantCard[]>();
  for (const card of newest) {
    const group = sources.get(card.source) ?? [];
    group.push(card);
    sources.set(card.source, group);
  }
  for (const group of sources.values()) {
    group.sort((a, b) => Number(isGrantUnused30d(b, now)) - Number(isGrantUnused30d(a, now)));
  }
  const offsets = new Map<string, number>();
  return newest.map(card => {
    const offset = offsets.get(card.source) ?? 0;
    offsets.set(card.source, offset + 1);
    return sources.get(card.source)![offset];
  });
}
